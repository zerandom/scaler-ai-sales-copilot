import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { renderPdf } from "./lib/render-pdf.js";

import "./lib/load-env.js";
import { scalerEvidencePack, selectEvidenceForInsights } from "./lib/evidence-pack.js";
import { benchmarkPersonas, detectPersonaStrategy } from "./lib/personas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "");
const supabase = createClient(
  supabaseUrl,
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const port = Number.parseInt(process.env.PORT || "3000", 10);
const generatedAssets = new Map();
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
    twilioConfigured: hasTwilioConfig(),
    publicBaseUrlConfigured: Boolean(process.env.PUBLIC_BASE_URL),
  });
});

app.get("/api/bootstrap", (_req, res) => {
  res.json({
    benchmarkPersonas,
    scalerEvidencePack,
  });
});

app.post("/api/generate-precall", async (req, res) => {
  try {
    const leadProfile = normalizeLeadProfile({
      ...req.body.leadProfile,
      transcript: "",
    });
    const bdaWhatsapp = normalizeWhatsapp(req.body.bda_whatsapp);

    if (!leadProfile.name || !leadProfile.intent) {
      return res.status(400).json({ error: "Lead name and intent are required." });
    }

    const strategy = detectPersonaStrategy(leadProfile);
    const insights = buildFallbackInsights(leadProfile, "");
    const evidence = selectEvidenceForInsights(insights);
    const precall = await generatePrecallNudge(leadProfile, insights, evidence, strategy);
    const sendResult = await sendWhatsappMessage({
      to: bdaWhatsapp,
      body: precall.message,
      audience: "bda",
    });

    return res.json({
      leadProfile,
      strategy,
      insights,
      evidence,
      precall,
      sendResult,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to generate pre-call nudge." });
  }
});

app.post("/api/generate-postcall", upload.single("audio"), async (req, res) => {
  try {
    const leadProfile = normalizeLeadProfile(parseJsonMaybe(req.body.leadProfile));
    const transcript = (req.body.transcript || "").trim();
    const bdaWhatsapp = normalizeWhatsapp(req.body.bda_whatsapp);
    const leadWhatsapp = normalizeWhatsapp(req.body.lead_whatsapp);
    const audioFile = req.file;

    if (!leadProfile.name || !leadWhatsapp) {
      return res.status(400).json({ error: "Lead name and lead WhatsApp number are required." });
    }

    let transcriptText = transcript;
    let transcriptionMeta = { mode: "structured", provider: "manual", warning: null };

    if (!transcriptText && audioFile) {
      const transcription = await transcribeAudio(audioFile);
      transcriptText = transcription.text;
      transcriptionMeta = {
        mode: "audio",
        provider: transcription.provider,
        warning: transcription.warning || null,
      };
    }

    if (!transcriptText) {
      return res.status(400).json({ error: "Provide either a transcript or an audio file." });
    }

    const strategy = detectPersonaStrategy({ ...leadProfile, transcript: transcriptText });
    const insights = await extractInsights(leadProfile, transcriptText, strategy);
    const evidence = selectEvidenceForInsights(insights);
    const generated = await generateLeadAsset({
      leadProfile,
      transcript: transcriptText,
      insights,
      evidence,
      strategy,
    });

    const assetId = crypto.randomUUID();

    let leadId = null;
    let baseUrl = process.env.PUBLIC_BASE_URL || "";
    if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    let pdfUrl = `${baseUrl}/assets/${assetId}.pdf`; 

    try {
      const { data: leadData, error: leadError } = await saveLeadToSupabase(leadProfile);
      if (leadError) console.warn("Lead save warning:", leadError.message);
      if (leadData) leadId = leadData.id;
      
      const pdfBuffer = Buffer.from(generated.pdfBytes);
      const friendlyName = `${(leadProfile.name || "Lead").replace(/\s+/g, "-")}-Scaler-Brief.pdf`;
      const uploadedUrl = await uploadPdfToSupabase(assetId, pdfBuffer, friendlyName);
      if (uploadedUrl) pdfUrl = uploadedUrl;
    } catch (supabaseErr) {
      console.warn("Supabase storage sync failed:", supabaseErr.message);
    }


    // Persist asset metadata for stateless approval and re-rendering
    const metadata = {
      id: assetId,
      createdAt: new Date().toISOString(),
      leadId,
      leadProfile,
      bdaWhatsapp,
      leadWhatsapp,
      transcript: transcriptText,
      strategy,
      insights,
      evidence,
      pdfUrl,
      ...generated, // Includes coverMessage, situationItems, goals, etc.
    };

    try {
      await supabase.storage.from("pdfs").upload(`${assetId}.json`, JSON.stringify(metadata), {
        contentType: "application/json",
        upsert: true,
      });
    } catch (metaErr) {
      console.warn("Metadata persistence failed:", metaErr.message);
    }

    generatedAssets.set(assetId, metadata);

    return res.json({
      assetId,
      leadProfile,
      strategy,
      insights,
      evidence,
      transcriptionMeta,
      coverMessage: generated.coverMessage,
      pdfPreviewHtml: generated.previewHtml,
      pdfUrl,
      approvalRequired: true,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to generate post-call assets." });
  }
});

app.post("/api/approve-send", async (req, res) => {
  try {
    const assetId = req.body.assetId;
    const action = req.body.action || "approve";
    const editedMessage = (req.body.editedMessage || "").trim();

    let asset = generatedAssets.get(assetId);
    
    // Fallback: Fetch from Supabase if stateless instance restarted
    if (!asset) {
      console.log(`Asset ${assetId} not in memory, fetching from Supabase...`);
      try {
        const { data, error } = await supabase.storage.from("pdfs").download(`${assetId}.json`);
        if (!error && data) {
          const text = await data.text();
          asset = JSON.parse(text);
          console.log("Asset metadata restored from storage.");
        }
      } catch (err) {
        console.error("Failed to restore asset metadata:", err.message);
      }
    }

    if (!asset) {
      return res.status(404).json({ error: "Generated asset not found or session expired." });
    }

    if (action === "skip") {
      asset.approval = {
        status: "skipped",
        updatedAt: new Date().toISOString(),
      };

      return res.json({
        status: "skipped",
        message: "Lead-facing send skipped by BDA.",
      });
    }

    const body = editedMessage || asset.coverMessage;
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.get("host");
    const fullBaseUrl = `${protocol}://${host}`;

    let mediaUrl = asset.pdfUrl;
    if (mediaUrl && !mediaUrl.startsWith("http")) {
      mediaUrl = `${fullBaseUrl}${mediaUrl}`;
    }

    const sendResult = await sendWhatsappMessage({
      to: asset.leadWhatsapp,
      body,
      mediaUrl,
      requiresMedia: true,
      audience: "lead",
    });

    // Supabase Integration: Log generation and status
    await logGenerationToSupabase({
      leadId: asset.leadId,
      pdfUrl: asset.pdfUrl,
      whatsappStatus: sendResult.status,
      whatsappSid: sendResult.sid || null,
    });

    asset.approval = {
      status: "sent",
      updatedAt: new Date().toISOString(),
      body,
      sendResult,
    };

    return res.json({
      status: "sent",
      sendResult,
      assetId,
      pdfUrl: asset.pdfUrl,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to approve and send asset." });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ 
    error: "Internal Server Error", 
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined
  });
});

if (isMainModule) {
  app.listen(port, () => {
    console.log(`Scaler AI Sales Copilot running on http://localhost:${port}`);
  });
}

// Fallback local PDF route (used when Supabase upload fails)
app.get("/assets/:assetId.pdf", async (req, res) => {
  const assetId = req.params.assetId;
  let asset = generatedAssets.get(assetId);

  try {
    let pdfBuffer;
    let fileName = `${assetId}.pdf`;

    if (asset && asset.pdfBytes) {
      pdfBuffer = Buffer.from(asset.pdfBytes);
    } else {
      // Fallback: Try to fetch from Supabase storage if not in memory
      console.log(`Asset ${assetId} missing from memory, checking Supabase...`);
      const { data, error } = await supabase.storage.from("pdfs").download(fileName);
      
      if (!error && data) {
        pdfBuffer = Buffer.from(await data.arrayBuffer());
      } else {
        // ULTIMATE FALLBACK: Re-render if we have metadata
        console.log(`PDF file missing, checking for metadata to re-render...`);
        const { data: metaData, error: metaError } = await supabase.storage.from("pdfs").download(`${assetId}.json`);
        if (!metaError && metaData) {
          const text = await metaData.text();
          const meta = JSON.parse(text);
          // Re-generate on the fly
          const reGenerated = await renderPdf(meta, meta.strategy, meta.leadProfile);
          pdfBuffer = Buffer.from(reGenerated);
        } else {
          return res.status(404).send(`Brief ${assetId} could not be found or re-generated.`);
        }
      }
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${(asset?.leadProfile?.name || "scaler-brief").replace(/\s+/g, "-").toLowerCase()}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (err) {
    console.error("Asset retrieval error:", err);
    return res.status(404).send("PDF not found.");
  }
});


function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeLeadProfile(input = {}) {
  let role = (input.role || "").trim();
  let company = "";
  if (role.includes(" at ")) {
    const parts = role.split(" at ");
    role = parts[0].trim();
    company = parts[1].trim();
  } else if (role.includes(",")) {
    const parts = role.split(",");
    role = parts[0].trim();
    company = parts[1].trim();
  }

  return {
    name: (input.name || "").trim(),
    role,
    company,
    experience: (input.experience || "").trim(),
    intent: (input.intent || "").trim(),
    links: (input.links || "").trim(),
    notes: (input.notes || "").trim(),
    transcript: (input.transcript || "").trim(),
  };
}

function normalizeWhatsapp(value = "") {
  if (!value) return "";
  const cleaned = String(value).replace(/[^\d+]/g, "");
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function hasTwilioConfig() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM
  );
}

function buildAssetUrl(relativePath) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  return new URL(relativePath, base).toString();
}

async function transcribeAudio(file) {
  if (!process.env.DEEPGRAM_API_KEY) {
    return {
      provider: "fallback",
      text:
        "Audio transcription fallback: Deepgram API key is not configured. Upload a transcript in the UI for precise extraction during local testing.",
      warning: "Using fallback transcription because DEEPGRAM_API_KEY is missing.",
    };
  }

  try {
    const response = await fetch(
      `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(
        process.env.DEEPGRAM_MODEL || "nova-3"
      )}&smart_format=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": file.mimetype || "application/octet-stream",
        },
        body: file.buffer,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text);
    }

    const payload = await response.json();
    const text =
      payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";

    if (!text) {
      throw new Error("Deepgram returned an empty transcript.");
    }

    return {
      provider: "deepgram",
      text,
      warning: null,
    };
  } catch (error) {
    return {
      provider: "fallback",
      text:
        "Audio transcription fallback: the transcription service was unavailable, so no precise transcript could be extracted. Please retry with a transcript for a higher-fidelity run.",
      warning: `Transcription fallback triggered: ${error.message}`,
    };
  }
}

async function extractInsights(leadProfile, transcript, strategy) {
  const fallback = buildFallbackInsights(leadProfile, transcript, strategy);

  if (!process.env.OPENROUTER_API_KEY) {
    return fallback;
  }

  const prompt = [
    "You are extracting post-call sales insights for a Scaler BDA.",
    "Return only valid JSON with these top-level keys:",
    "explicit_questions, implicit_questions, purchase_barriers, emotional_signals, goals, recommended_proof, evidence_gaps, summary.",
    "Each list should contain short strings.",
    "Be honest. If something is not stated, infer cautiously.",
    `Lead profile: ${JSON.stringify(leadProfile)}`,
    `Persona strategy: ${JSON.stringify(strategy)}`,
    `Transcript: ${transcript}`,
  ].join("\n");

  try {
    const payload = await runChatCompletion({
      model: process.env.OPENROUTER_EXTRACTION_MODEL || "openrouter/free",
      system:
        "You produce concise, valid JSON. Do not wrap the JSON in markdown fences or commentary.",
      user: prompt,
      temperature: 0.2,
    });

    const parsed = JSON.parse(payload);
    return {
      explicit_questions: ensureArray(parsed.explicit_questions, fallback.explicit_questions),
      implicit_questions: ensureArray(parsed.implicit_questions, fallback.implicit_questions),
      purchase_barriers: ensureArray(parsed.purchase_barriers, fallback.purchase_barriers),
      emotional_signals: ensureArray(parsed.emotional_signals, fallback.emotional_signals),
      goals: ensureArray(parsed.goals, fallback.goals),
      recommended_proof: ensureArray(parsed.recommended_proof, fallback.recommended_proof),
      evidence_gaps: ensureArray(parsed.evidence_gaps, fallback.evidence_gaps),
      summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
    };
  } catch {
    return fallback;
  }
}

function buildFallbackInsights(leadProfile, transcript, strategy = detectPersonaStrategy(leadProfile)) {
  const lower = transcript.toLowerCase();
  const explicitQuestions = extractExplicitQuestions(transcript);
  const implicitQuestions = [];
  const purchaseBarriers = [];
  const emotionalSignals = [];
  const goals = [];
  const recommendedProof = [];
  const evidenceGaps = [];

  if (leadProfile.intent) goals.push(leadProfile.intent);
  if (lower.includes("salary") || lower.includes("lpa")) {
    purchaseBarriers.push("roi", "career-transition");
    recommendedProof.push("roi", "outcomes");
  }
  if (lower.includes("coursera") || lower.includes("free")) {
    purchaseBarriers.push("program-differentiation");
    recommendedProof.push("projects", "mentorship", "program-design");
  }
  if (lower.includes("rag") || lower.includes("agent") || lower.includes("llm")) {
    recommendedProof.push("genai", "applied-ai");
  }
  if (lower.includes("cohort")) {
    purchaseBarriers.push("peer-group");
    recommendedProof.push("community");
  }
  if (lower.includes("instructor") || lower.includes("academic")) {
    purchaseBarriers.push("credibility");
    recommendedProof.push("instructors", "practitioner");
  }
  if (lower.includes("parents") || lower.includes("family")) {
    emotionalSignals.push("needs family confidence");
    purchaseBarriers.push("risk", "job-uncertainty");
  }
  if (lower.includes("afford") || lower.includes("3.5")) {
    emotionalSignals.push("high financial sensitivity");
    purchaseBarriers.push("financing");
    evidenceGaps.push("No grounded financing details were provided in the evidence pack.");
  }
  if (lower.includes("entrance test")) {
    emotionalSignals.push("nervous about screening");
    purchaseBarriers.push("screening anxiety");
    evidenceGaps.push("Specific entrance test standards should be confirmed by the sales team.");
  }
  if (lower.includes("google") || lower.includes("paper")) {
    emotionalSignals.push("skeptical and advanced");
    purchaseBarriers.push("depth");
    recommendedProof.push("hands-on", "practitioner");
  }
  if (lower.includes("too late")) {
    emotionalSignals.push("career timing anxiety");
  }

  // Always populate implicit questions based on strategy
  if (!implicitQuestions.length) {
    if (strategy.key === "senior-operator") {
      implicitQuestions.push(
        "Is this cohort genuinely selective enough for my level?",
        "Will the applied projects be meaningfully different from what I can self-study?",
        "Are the instructors practitioners or academics?"
      );
    } else if (strategy.key === "career-risk") {
      implicitQuestions.push(
        "Can I trust Scaler's placement numbers — are they real?",
        "What happens if I don't crack the entrance test?",
        "Is this decision going to be hard to justify to my family?"
      );
    } else {
      implicitQuestions.push(
        "Is Scaler actually worth 3.5L compared to free alternatives?",
        "Will I get a job after completing this, or is it just a certificate?",
        "Will the peer group be driven engineers or just beginners?"
      );
    }
  }

  // Always populate evidence gaps with useful coaching notes
  if (!evidenceGaps.length) {
    evidenceGaps.push(
      "No specific salary benchmark was confirmed — follow up with current CTC and target CTC.",
      "Placement outcome data was referenced but not directly shown — share the alumni outcomes deck.",
      "Financing terms were not discussed in detail — BDA should confirm EMI and ISA options."
    );
  }

  return {
    explicit_questions: explicitQuestions,
    implicit_questions: dedupe(implicitQuestions),
    purchase_barriers: dedupe(purchaseBarriers),
    emotional_signals: dedupe(emotionalSignals),
    goals: dedupe(goals),
    recommended_proof: dedupe(recommendedProof),
    evidence_gaps: dedupe(evidenceGaps),
    summary: buildSummary(leadProfile, strategy, purchaseBarriers, emotionalSignals),
  };
}

function extractExplicitQuestions(transcript) {
  return dedupe(
    transcript
      .split(/(?<=[?])/)
      .map((segment) => segment.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((segment) => segment.includes("?"))
      .slice(0, 6)
  );
}

function buildSummary(leadProfile, strategy, barriers, signals) {
  return `${leadProfile.name || "This lead"} is in a ${strategy.title.toLowerCase()} context. Primary blockers: ${
    barriers.slice(0, 3).join(", ") || "general uncertainty"
  }. Emotional tone: ${signals.slice(0, 2).join(", ")}.`;
}

async function generatePrecallNudge(leadProfile, insights, evidence, strategy) {
  const fallback = buildFallbackPrecall(leadProfile, insights, strategy);

  if (!process.env.OPENROUTER_API_KEY) {
    return fallback;
  }

  const prompt = [
    "You are a sharp internal sales copilot for a Scaler BDA.",
    "Write a short WhatsApp-style prep message for the BDA.",
    "It must include clearly labeled Fact, Inference, and Missing sections.",
    "Also include 2-3 hooks, 2-3 likely objections with one-line handles, and one opening line.",
    "Keep it scannable and specific. No corporate memo tone.",
    `Lead: ${JSON.stringify(leadProfile)}`,
    `Insights: ${JSON.stringify(insights)}`,
    `Evidence pack: ${JSON.stringify(evidence)}`,
    `Persona strategy: ${JSON.stringify(strategy)}`,
    'Return JSON with keys: message, opening_line, hooks, objections.',
  ].join("\n");

  try {
    const payload = await runChatCompletion({
      model: process.env.OPENROUTER_GENERATION_MODEL || "openrouter/free",
      system:
        "You produce concise, polished JSON. Do not wrap the JSON in markdown fences.",
      user: prompt,
      temperature: 0.7,
    });

    const parsed = JSON.parse(payload);
    return {
      message: typeof parsed.message === "string" ? parsed.message : fallback.message,
      openingLine:
        typeof parsed.opening_line === "string" ? parsed.opening_line : fallback.openingLine,
      hooks: ensureArray(parsed.hooks, fallback.hooks),
      objections: ensureArray(parsed.objections, fallback.objections),
    };
  } catch {
    return fallback;
  }
}

function buildFallbackPrecall(leadProfile, insights, strategy) {
  const facts = [
    leadProfile.role && `${leadProfile.name} is currently ${leadProfile.role}.`,
    leadProfile.experience && `Experience: ${leadProfile.experience}.`,
    leadProfile.intent && `Intent: ${leadProfile.intent}`,
  ].filter(Boolean);

  const hooks = buildHooks(leadProfile, strategy);
  const objections = buildObjections(insights);
  const openingLine = buildOpeningLine(leadProfile, strategy);

  const message = [
    `Pre-call brief for ${leadProfile.name}`,
    "",
    "Fact",
    facts.map((item) => `- ${item}`).join("\n"),
    "",
    "Inference",
    `- Likely persona: ${strategy.title}.`,
    `- Emotional signals: ${(insights.emotional_signals || []).slice(0, 2).join(", ")}.`,
    "",
    "Missing",
    `- ${insights.evidence_gaps?.[0] || "Any program-specific detail not grounded in the evidence pack should be confirmed before promising it."}`,
    "",
    "Hooks",
    hooks.map((item) => `- ${item}`).join("\n"),
    "",
    "Likely objections",
    objections.map((item) => `- ${item}`).join("\n"),
    "",
    `Opening line: ${openingLine}`,
  ].join("\n");

  return { message, openingLine, hooks, objections };
}

function buildHooks(leadProfile, strategy) {
  if (strategy.key === "senior-operator") {
    return [
      "Acknowledge that he already has strong fundamentals and frame the call around applied leverage, not basics.",
      "Lead with production AI depth and the value of evaluated projects over passive paper-reading.",
      "Invite him to pressure-test cohort and instructor quality instead of giving a generic pitch.",
    ];
  }

  if (strategy.key === "career-risk") {
    return [
      "Start by recognizing the family-vs-career tension before talking about programs.",
      "Frame Scaler as a structured support system, not a guarantee machine.",
      "Normalize the entrance test as signal for readiness and learning path, not a personal verdict.",
    ];
  }

  return [
    "Open on his move from service work to product-oriented, applied AI roles.",
    "Tie value to practical builds, not just content access.",
    "Anchor the call in ROI: better role quality and career upside, not vague inspiration.",
  ];
}

function buildObjections(insights) {
  const barriers = insights.purchase_barriers || [];
  const mapped = [];

  if (barriers.includes("roi")) {
    mapped.push("ROI: Use reported outcome signals carefully and tie value to role quality, not blanket salary promises.");
  }
  if (barriers.includes("program-differentiation")) {
    mapped.push("Free vs paid: Position structure, evaluated projects, mentor feedback, and accountability as the difference.");
  }
  if (barriers.includes("depth")) {
    mapped.push("Depth: Emphasize applied production workflows and peer-level challenge rather than introductory theory.");
  }
  if (barriers.includes("financing")) {
    mapped.push("Affordability: Explain that financing specifics should be confirmed transparently rather than guessed.");
  }
  if (barriers.includes("screening anxiety")) {
    mapped.push("Entrance test fear: Frame the assessment as a fit and readiness checkpoint, not a value judgment.");
  }

  return mapped.length
    ? mapped.slice(0, 3)
    : [
        "Generic skepticism: Stay specific, grounded, and avoid any unsupported claim.",
        "Time commitment: Emphasize structure and practical relevance.",
      ];
}

function buildOpeningLine(leadProfile, strategy) {
  if (strategy.key === "senior-operator") {
    return `You already have the fundamentals, so I’d love to focus this on one thing: where a structured applied AI program could still give you leverage beyond self-study.`;
  }
  if (strategy.key === "career-risk") {
    return `Before we even talk about Scaler, I want to understand the decision you’re balancing between the safer offer and the career you actually want.`;
  }
  return `You’re not just looking for another course here — you’re trying to change the kind of engineering work you get to do next.`;
}

async function generateLeadAsset({ leadProfile, transcript, insights, evidence, strategy }) {
  const fallback = buildFallbackLeadAsset({ leadProfile, transcript, insights, evidence, strategy });

  if (!process.env.OPENROUTER_API_KEY) {
    return await materializeLeadAsset(fallback, strategy, leadProfile, evidence);
  }

  const prompt = [
    "You are creating a 6-slide personalized Scaler career plan PDF for a post-call follow-up.",
    "Return ONLY valid JSON with these exact keys:",
    "cover_message: short personalized WhatsApp message (string)",
    "subtitle: one line tagline for the cover (string)",
    "situation_items: exactly 5 objects {icon_letter (1 char), title, description} describing where the lead stands today",
    "goals: exactly 3 objects {icon_letter (1-2 chars), title, description} representing their career goals",
    "target_roles: array of 4-6 job title strings they are targeting",
    "pull_quote: one powerful sentence about their career journey (string)",
    "questions_answered: exactly 3 objects {icon_letter (1-2 chars), question (the lead's real concern as a quote), answer (direct 1-2 sentence answer)}",
    "bottom_line: one crisp sentence summarizing the program fit (string)",
    "why_scaler_features: exactly 6 objects {icon_letter (1-2 chars), title, description} for why Scaler fits this lead",
    "next_step_title: title for the CTA slide (string)",
    "next_step_body: 1-2 sentence description of the assessment (string)",
    "why_take_it: exactly 4 short strings (checklist items for why to take the assessment)",
    "CRITICAL: You MUST adopt the persona strategy voice exactly. Your output must read visibly differently depending on the strategy. Do not converge to a generic middle.",
    "Use only grounded evidence. Be specific to this lead. No generic marketing.",
    `Lead: ${JSON.stringify(leadProfile)}`,
    `Persona strategy: ${JSON.stringify(strategy)}`,
    `Insights: ${JSON.stringify(insights)}`,
    `Evidence pack: ${JSON.stringify(evidence)}`,
    `Transcript: ${transcript}`,
  ].join("\n");

  try {
    const payload = await runChatCompletion({
      model: process.env.OPENROUTER_GENERATION_MODEL || "anthropic/claude-3-5-haiku",
      system:
        "You produce warm, polished JSON only. Do not fabricate facts. Do not wrap JSON in markdown.",
      user: prompt,
      temperature: 0.85,
    });

    const parsed = JSON.parse(payload);
    return await materializeLeadAsset(
      {
        coverMessage:
          typeof parsed.cover_message === "string" ? parsed.cover_message : fallback.coverMessage,
        subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : fallback.subtitle,
        situationItems: Array.isArray(parsed.situation_items) && parsed.situation_items.length
          ? parsed.situation_items : fallback.situationItems,
        goals: Array.isArray(parsed.goals) && parsed.goals.length
          ? parsed.goals : fallback.goals,
        targetRoles: Array.isArray(parsed.target_roles) && parsed.target_roles.length
          ? parsed.target_roles : fallback.targetRoles,
        pullQuote: typeof parsed.pull_quote === "string" ? parsed.pull_quote : fallback.pullQuote,
        questionsAnswered: Array.isArray(parsed.questions_answered) && parsed.questions_answered.length
          ? parsed.questions_answered : fallback.questionsAnswered,
        bottomLine: typeof parsed.bottom_line === "string" ? parsed.bottom_line : fallback.bottomLine,
        whyScalerFeatures: Array.isArray(parsed.why_scaler_features) && parsed.why_scaler_features.length
          ? parsed.why_scaler_features : fallback.whyScalerFeatures,
        nextStepTitle:
          typeof parsed.next_step_title === "string" ? parsed.next_step_title : fallback.nextStepTitle,
        nextStepBody:
          typeof parsed.next_step_body === "string" ? parsed.next_step_body : fallback.nextStepBody,
        whyTakeIt: Array.isArray(parsed.why_take_it) && parsed.why_take_it.length
          ? parsed.why_take_it : fallback.whyTakeIt,
      },
      strategy,
      leadProfile,
      evidence
    );
  } catch {
    return await materializeLeadAsset(fallback, strategy, leadProfile, evidence);
  }
}

function buildFallbackLeadAsset({ leadProfile, insights, evidence, strategy }) {
  const first = leadProfile.name.split(" ")[0];

  if (strategy.key === "senior-operator") {
    return {
      coverMessage: `Hi ${first}, sharing a focused summary on the questions you raised: applied depth, cohort quality, and where a structured program still adds leverage at your level.`,
      subtitle: "A practical read on where structured execution adds value beyond self-study.",
      situationItems: [
        { icon_letter: "Y", title: `${leadProfile.experience || "7+"} years at ${leadProfile.company || leadProfile.role || "a tech company"}`, description: "Strong fundamentals and production experience already in place." },
        { icon_letter: "A", title: "Self-directed AI upskilling", description: "Reading papers, running experiments, exploring models independently." },
        { icon_letter: "G", title: "Evaluating structured programs", description: "Looking for whether a cohort-based program adds real leverage beyond solo study." },
        { icon_letter: "P", title: "Peer-level criteria", description: "Determining if the cohort and instructors truly operate at a senior practitioner level." },
        { icon_letter: "Q", title: "Key questions", description: "Cohort seniority, instructor caliber, project depth — are these genuinely at your level?", is_good_news: false },
      ],
      goals: [
        { icon_letter: "AI", title: "Lead AI Engineering", description: "Build and own production AI systems end-to-end." },
        { icon_letter: "P", title: "Practitioner Peer Network", description: "Work alongside engineers who are actively shipping AI." },
        { icon_letter: "L", title: "Applied Leverage", description: "Go beyond theory to evaluated, shipped production work." },
      ],
      targetRoles: ["AI Engineer", "Staff AI Engineer", "ML Platform Engineer", "LLM Systems Engineer"],
      pullQuote: "It's not about more content — it's about whether the cohort and projects match your current bar.",
      questionsAnswered: [
        { icon_letter: "C", question: "Will the cohort be at my level?", answer: "Scaler positions the program as selective. Ask directly for the median YOE of the current batch — this is the clearest signal." },
        { icon_letter: "AI", question: "Will I actually build production AI systems?", answer: "The GenAI specialization covers RAG pipelines, LLM evals, and agent frameworks. Ask to see one real project brief and its rubric." },
        { icon_letter: "M", question: "Are the instructors practitioners or academics?", answer: "Mentors are framed as active industry professionals. Ask for one specific instructor and what they have shipped recently." },
      ],
      bottomLine: "At your level, the only question worth answering is whether the cohort and applied projects genuinely match your bar.",
      whyScalerFeatures: [
        { icon_letter: "C", title: "Industry-Relevant Curriculum", description: "Focused on the exact AI stack product companies are hiring for." },
        { icon_letter: "P", title: "Practitioner Mentors", description: "Instructors who have built and scaled AI systems in leading tech companies." },
        { icon_letter: "A", title: "Applied AI Labs", description: "Module-by-module builds — you ship throughout, not just at the capstone." },
        { icon_letter: "E", title: "Evaluated Projects", description: "Structured feedback on your work, not just passive learning." },
        { icon_letter: "N", title: "Senior Peer Network", description: "A cohort filtered for serious practitioners, not mass enrollment." },
        { icon_letter: "Q", title: "Quarterly Curriculum Updates", description: "Fast-moving AI tooling means the curriculum can't afford to be static." },
      ],
      nextStepTitle: "Take the Assessment",
      nextStepBody: "The assessment helps evaluate your current depth and recommend the right cohort. It's the fastest way to see if the peer bar matches yours.",
      whyTakeIt: ["Understand your applied AI readiness", "See if the cohort matches your level", "Get a concrete module walkthrough", "Make a grounded, data-driven decision"],
    };
  }

  if (strategy.key === "career-risk") {
    return {
      coverMessage: `Hi ${first}, sharing the note I promised — focused on helping you make a credible decision you can discuss honestly with your family.`,
      subtitle: "A grounded summary of what's real, what needs confirmation, and how to frame the risk.",
      situationItems: [
        { icon_letter: "S", title: `${leadProfile.role || "Final year student"} at a crossroads`, description: "Weighing a secure offer against the possibility of a better long-term career path." },
        { icon_letter: "F", title: "Family confidence matters", description: "The decision needs to feel credible to your family, not just to you." },
        { icon_letter: "E", title: "Financial sensitivity", description: "High stakes regarding the program fee and need for clear financing terms." },
        { icon_letter: "T", title: "Entrance test concern", description: "Nervous about the screening process and what it means for your candidacy." },
        { icon_letter: "R", title: "The good news", description: "You don't need certainty today — you need the right information to decide clearly.", is_good_news: true },
      ],
      goals: [
        { icon_letter: "P", title: "Product Company Role", description: "Transition from a service-based path to a product-oriented career." },
        { icon_letter: "S", title: "Salary & Growth", description: "Meaningful compensation improvement with a clear upward trajectory." },
        { icon_letter: "C", title: "Family Confidence", description: "A path credible enough to discuss honestly with your family." },
      ],
      targetRoles: ["Software Engineer (Product)", "Backend Engineer", "Full Stack Engineer", "Associate Engineer (AI/ML)"],
      pullQuote: "Stability and career growth are not mutually exclusive — but you need the financing terms in writing before any decision.",
      questionsAnswered: [
        { icon_letter: "R", question: "Is the ROI worth giving up a secure offer?", answer: "The ROI is in the long-term trajectory, not just the next offer. Product company roles compound over time — but only if placement and financing terms are transparent and confirmed." },
        { icon_letter: "T", question: "What happens if I don't clear the entrance test?", answer: "Ask the BDA directly: what percentage of first-time applicants pass, and is there a retry path? The test is a readiness checkpoint, not a final verdict on your potential." },
        { icon_letter: "$", question: "How does the financing actually work?", answer: "Get the full breakdown in writing — upfront, EMI, ISA options, and what counts as a qualifying placement. No family decision should be made without written clarity on every term." },
      ],
      bottomLine: "Get written answers on financing and placement terms first — then you'll have everything you need for an honest conversation with your family.",
      whyScalerFeatures: [
        { icon_letter: "C", title: "Structured Learning Path", description: "Clear progression from fundamentals through projects and interview prep." },
        { icon_letter: "M", title: "1:1 Mentorship", description: "Personal guidance from practitioners, not just recorded lectures." },
        { icon_letter: "I", title: "Mock Interview Support", description: "Resume, interview, and referral support to help you land the right role." },
        { icon_letter: "N", title: "Learner Network", description: "A large community of engineers on the same journey." },
        { icon_letter: "F", title: "Financing Options", description: "Multiple payment structures — confirm the exact terms in writing." },
        { icon_letter: "O", title: "Proven Outcomes", description: "Reported alumni outcomes — treat as signals, not personal guarantees." },
      ],
      nextStepTitle: "Take the Assessment",
      nextStepBody: "The assessment identifies your current level and recommends the right learning path. It's also your clearest signal of whether this program is the right fit right now.",
      whyTakeIt: ["Know exactly where you stand", "Get a personalized learning roadmap", "Understand your batch fit before deciding", "Move one step closer to a confident decision"],
    };
  }

  return {
    coverMessage: `Hi ${first}, sharing a personalized summary from our call — focused on the move you want to make into product and AI roles, and where Scaler appears to add real leverage.`,
    subtitle: "Built for your goals. Backed by real outcomes.",
    situationItems: [
      { icon_letter: "R", title: `${leadProfile.experience || "4 years"} at ${leadProfile.company || leadProfile.role || "a service company"}`, description: "Working on backend systems with strong fundamentals and production experience." },
      { icon_letter: "A", title: "Actively upskilling", description: "Completed AWS certification — a clear signal of your intent to grow." },
      { icon_letter: "C", title: "Career crossroads", description: "Ready to move from service-based to product company and AI-driven roles." },
      { icon_letter: "I", title: "Seeking applied depth", description: "Looking for real LLM applications like RAG and agents, not just theory." },
      { icon_letter: "G", title: "The good news", description: "You already have the right foundation. You don't need to start from scratch — you need the right direction and depth.", is_good_news: true },
    ],
    goals: [
      { icon_letter: "P", title: "Move to Product Companies", description: "Transition from service-based to product-oriented organizations." },
      { icon_letter: "AI", title: "Become an AI Engineer", description: "Work on cutting-edge AI systems, LLMs, and intelligent applications." },
      { icon_letter: "S", title: "Better Career & Salary Growth", description: "Improve your earning potential and long-term career trajectory." },
    ],
    targetRoles: ["AI Engineer", "ML Engineer", "Backend Engineer (AI/ML)", "Applied AI Engineer", "LLM Engineer", "Data Engineer (AI Focused)"],
    pullQuote: "It's not just about a job change. It's about building a career that compounds over the next 5-10 years.",
    questionsAnswered: [
      { icon_letter: "F", question: "Why not just learn from free resources like Andrew Ng courses?", answer: "Content is available, but structure, depth, mentorship, peer group and real-world projects make the real difference in career transition." },
      { icon_letter: "$", question: "Is the ROI worth 3.5L?", answer: "The real ROI is not just in salary jump (14 to 16 LPA) — it's the shift from service-based to product-based roles, which compounds over your career." },
      { icon_letter: "C", question: "Will I learn practical AI or just theory?", answer: "The program focuses on building production-ready AI systems — RAG, Agents, Evaluation, and more. You build throughout, not just at the end." },
    ],
    bottomLine: "This program is designed for engineers like you who want to build, ship, and lead AI products — not just learn concepts.",
    whyScalerFeatures: [
      { icon_letter: "C", title: "Industry-Relevant Curriculum", description: "Focused on the skills top product companies are hiring for." },
      { icon_letter: "P", title: "Learn from Top Practitioners", description: "Instructors who have built and scaled AI systems in leading tech companies." },
      { icon_letter: "G", title: "Strong Peer Community", description: "Learn and grow with driven engineers on the same career journey." },
      { icon_letter: "AI", title: "Build Real AI Systems", description: "Hands-on projects with LLMs, Agents, RAG, Vector DBs and more." },
      { icon_letter: "S", title: "Career Support That Works", description: "Resume, interviews, referrals and mock interviews to help you land the role." },
      { icon_letter: "O", title: "Proven Outcomes", description: "Our learners see significant career growth and role transitions." },
    ],
    nextStepTitle: "Take the Assessment",
    nextStepBody: "The assessment helps us understand your current level and recommend the right learning path for you.",
    whyTakeIt: ["Know where you stand", "Identify your strengths and gaps", "Get a tailored learning roadmap", "Move one step closer to your goal"],
  };
}




async function materializeLeadAsset(assetData, strategy, leadProfile, evidence) {
  const previewHtml = renderPreviewHtml(assetData, strategy, leadProfile, evidence);
  const pdfBytes = await renderPdf(assetData, strategy, leadProfile, evidence);

  return {
    ...assetData,
    previewHtml,
    pdfBytes,
  };
}

function renderPreviewHtml(assetData, strategy, leadProfile) {
  const primary = strategy.palette?.[0] || "#0e2238";
  
  const sections = [
    { 
      title: "WHERE YOU STAND", 
      content: (assetData.situationItems || []).map(it => `<div><strong>${escapeHtml(it.title)}</strong>: ${escapeHtml(it.description)}</div>`).join("") 
    },
    { 
      title: "YOUR GOALS", 
      content: (assetData.goals || []).map(g => `<div><strong>${escapeHtml(g.title)}</strong>: ${escapeHtml(g.description)}</div>`).join("") 
    },
    { 
      title: "TARGET ROLES", 
      content: `<div class="pills">${(assetData.targetRoles || []).map(r => `<span>${escapeHtml(r)}</span>`).join(" ")}</div>` 
    },
    { 
      title: "KEY QUESTIONS", 
      content: (assetData.questionsAnswered || []).map(q => `<div><strong>Q: ${escapeHtml(q.question)}</strong><br>A: ${escapeHtml(q.answer)}</div>`).join("<hr>") 
    },
    { 
      title: "WHY SCALER", 
      content: (assetData.whyScalerFeatures || []).map(f => `<div><strong>${escapeHtml(f.title)}</strong>: ${escapeHtml(f.description)}</div>`).join("") 
    },
    { 
      title: "NEXT STEP", 
      content: `<div><strong>${escapeHtml(assetData.nextStepTitle)}</strong></div><p>${escapeHtml(assetData.nextStepBody)}</p>` 
    }
  ];

  const htmlContent = sections.map(sec => `
    <div class="preview-section-v2">
      <div class="sec-label">${sec.title}</div>
      <div class="sec-content">${sec.content}</div>
    </div>
  `).join("");

  return `
    <div class="pdf-preview-shell-v2" style="--primary:${primary}">
      <header class="pdf-preview-header-v2">
        <div class="badge">A4 LANDSCAPE DECK • 6 SLIDES</div>
        <h1>${escapeHtml(leadProfile.name)}</h1>
        <p>${escapeHtml(assetData.subtitle || "Your Personalized Career Plan")}</p>
      </header>
      <main class="preview-main-v2">
        ${htmlContent}
      </main>
      <div class="preview-pull-quote">"${escapeHtml(assetData.pullQuote || "")}"</div>
    </div>
  `;
}

// renderPdf is imported from ./lib/render-pdf.js


function drawSection() {
  // legacy shim — no longer used by renderPdf but kept for safety
}

function drawRect(page, x, y, width, height, hexColor) {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: hexColor,
  });
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  const r = ((bigint >> 16) & 255) / 255;
  const g = ((bigint >> 8) & 255) / 255;
  const b = (bigint & 255) / 255;
  return rgb(r, g, b);
}

function wrapText(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    const width = font.widthOfTextAtSize(nextLine, size);
    if (width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = nextLine;
    }
  }

  if (line) lines.push(line);
  return lines;
}

async function sendWhatsappMessage({ to, body, mediaUrl, requiresMedia = false, audience }) {
  if (!to) {
    return {
      status: "skipped",
      reason: "Recipient WhatsApp number missing.",
      audience,
    };
  }

  if (!hasTwilioConfig()) {
    return {
      status: "simulated",
      audience,
      to,
      body,
      mediaUrl: mediaUrl || null,
      reason: "Twilio environment variables are not configured.",
    };
  }

  if (requiresMedia && !mediaUrl) {
    return {
      status: "pending_public_url",
      audience,
      to,
      body,
      mediaUrl,
      reason: "PUBLIC_BASE_URL is required for WhatsApp media delivery.",
    };
  }

  console.log(`Sending WhatsApp (${audience}) to: ${to}`);
  
  // Twilio requires a '+' for international numbers
  const formattedTo = to.startsWith("+") ? to : `+${to}`;

  const params = new URLSearchParams();
  params.set("To", `whatsapp:${formattedTo}`);
  params.set("From", process.env.TWILIO_WHATSAPP_FROM);
  
  // If mediaUrl is not public (e.g. local /assets/ path), Twilio will fail.
  // Fallback: append the URL to the text body instead of using MediaUrl.
  const isPublicUrl = mediaUrl && (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://"));
  
  if (requiresMedia && mediaUrl && !isPublicUrl) {
    params.set("Body", `${body}\n\nView your career plan here: ${mediaUrl}`);
  } else {
    params.set("Body", body);
    if (mediaUrl && isPublicUrl) params.set("MediaUrl", mediaUrl);
  }

  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  const payload = await response.json();
  if (!response.ok) {
    return {
      status: "error",
      audience,
      error: payload.message || "Twilio send failed.",
      details: payload,
    };
  }

  return {
    status: "sent",
    audience,
    sid: payload.sid,
    to: payload.to,
  };
}

async function runChatCompletion({ model, system, user, temperature }) {
  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };

  if (process.env.PUBLIC_BASE_URL) {
    headers["HTTP-Referer"] = process.env.PUBLIC_BASE_URL;
  }
  headers["X-Title"] = "Scaler AI Sales Copilot";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      plugins: [{ id: "response-healing" }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }

  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || "{}";
}

function ensureArray(value, fallback) {
  return Array.isArray(value) && value.length ? dedupe(value.map(String)) : fallback;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function saveLeadToSupabase(leadProfile) {
  const { data, error } = await supabase
    .from("leads")
    .upsert(
      {
        name: leadProfile.name,
        phone: leadProfile.phone || null,
        role: leadProfile.role || null,
        experience: leadProfile.experience || null,
        company: leadProfile.company || null,
      },
      { onConflict: "name" }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function uploadPdfToSupabase(assetId, pdfBuffer, friendlyName) {
  // We use the friendly name as the actual path so it looks good to the user
  const fileName = friendlyName || `${assetId}.pdf`;
  const bucketName = "pdfs";

  // Ensure bucket exists
  try {
    const { data: bucketData, error: bucketError } = await supabase.storage.getBucket(bucketName);
    if (bucketError || !bucketData) {
      console.log(`Bucket '${bucketName}' not found, attempting to create...`);
      await supabase.storage.createBucket(bucketName, {
        public: true,
      });
    }
  } catch (err) {
    console.warn("Storage bucket check skipped/failed:", err.message);
  }

  console.log(`Uploading ${fileName} to bucket '${bucketName}'...`);
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(fileName, pdfBuffer, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: true,
      // This header helps when downloading
      contentDisposition: `inline; filename="${fileName}"`,
    });

  if (error) {
    console.error("Supabase storage upload error:", error);
    throw error;
  }

  // We use the UUID as the key but return a URL with a friendly filename hint if possible
  const { data } = supabase.storage.from(bucketName).getPublicUrl(fileName);
  return data.publicUrl;
}

async function logGenerationToSupabase({ leadId, pdfUrl, whatsappStatus, whatsappSid }) {
  const { data, error } = await supabase
    .from("generation_logs")
    .insert({
      lead_id: leadId,
      pdf_url: pdfUrl,
      whatsapp_status: whatsappStatus,
      whatsapp_sid: whatsappSid,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export default app;

export {
  app,
  benchmarkPersonas,
  buildFallbackInsights,
  buildFallbackLeadAsset,
  buildFallbackPrecall,
  detectPersonaStrategy,
  extractInsights,
  generateLeadAsset,
  generatePrecallNudge,
  normalizeLeadProfile,
  renderPdf,
  scalerEvidencePack,
  selectEvidenceForInsights,
};
