import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
      const lead = await saveLeadToSupabase(leadProfile);
      leadId = lead.id;
      const uploadedUrl = await uploadPdfToSupabase(assetId, generated.pdfBytes);
      if (uploadedUrl) pdfUrl = uploadedUrl;
    } catch (supabaseErr) {
      console.warn("Supabase integration failed (non-fatal):", supabaseErr.message);
    }

    generatedAssets.set(assetId, {
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
      ...generated,
    });

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

    const asset = generatedAssets.get(assetId);
    if (!asset) {
      return res.status(404).json({ error: "Generated asset not found." });
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
    const mediaUrl = asset.pdfUrl; // Use the Supabase URL
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
      const { data, error } = await supabase.storage.from("pdfs").download(fileName);
      if (error || !data) {
        return res.status(404).send("PDF not found in memory or storage.");
      }
      pdfBuffer = Buffer.from(await data.arrayBuffer());
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
  return {
    name: (input.name || "").trim(),
    role: (input.role || "").trim(),
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

  if (!goals.length && strategy.key === "senior-operator") {
    goals.push("Validate whether a structured applied AI program adds value beyond self-study.");
  }
  if (!goals.length && strategy.key === "career-risk") {
    goals.push("Choose a credible path into a product-company career without reckless risk.");
  }
  if (!goals.length) {
    goals.push("Move into stronger software or AI-oriented roles with better alignment and upside.");
  }

  if (!emotionalSignals.length) {
    emotionalSignals.push("needs clearer confidence before taking the next step");
  }

  if (!recommendedProof.length) {
    recommendedProof.push("projects", "mentorship", "career-support");
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
    "situation_items: exactly 4 objects {icon_letter (1 char), title, description} describing where the lead stands today",
    "goals: exactly 3 objects {icon_letter (1-2 chars), title, description} representing their career goals",
    "target_roles: array of 4-6 job title strings they are targeting",
    "pull_quote: one powerful sentence about their career journey (string)",
    "questions_answered: exactly 3 objects {icon_letter (1-2 chars), question (the lead's real concern as a quote), answer (direct 1-2 sentence answer)}",
    "bottom_line: one crisp sentence summarizing the program fit (string)",
    "why_scaler_features: exactly 6 objects {icon_letter (1-2 chars), title, description} for why Scaler fits this lead",
    "next_step_title: title for the CTA slide (string)",
    "next_step_body: 1-2 sentence description of the assessment (string)",
    "why_take_it: exactly 4 short strings (checklist items for why to take the assessment)",
    "Use only grounded evidence. Be specific to this lead. No generic marketing.",
    `Lead: ${JSON.stringify(leadProfile)}`,
    `Persona strategy: ${JSON.stringify(strategy)}`,
    `Insights: ${JSON.stringify(insights)}`,
    `Evidence pack: ${JSON.stringify(evidence)}`,
    `Transcript: ${transcript}`,
  ].join("\n");

  try {
    const payload = await runChatCompletion({
      model: process.env.OPENROUTER_GENERATION_MODEL || "openrouter/free",
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
        { icon_letter: "Y", title: `${leadProfile.experience || "7+"} years at ${leadProfile.role || "a tech company"}`, description: "Strong fundamentals and production experience already in place." },
        { icon_letter: "A", title: "Self-directed AI upskilling", description: "Reading papers, running experiments, exploring models independently." },
        { icon_letter: "G", title: "Evaluating structured programs", description: "Looking for whether a cohort-based program adds real leverage beyond solo study." },
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
      { icon_letter: "R", title: `${leadProfile.experience || "4 years"} at ${leadProfile.role || "a service company"}`, description: "Working on backend systems with strong fundamentals and production experience." },
      { icon_letter: "A", title: "Actively upskilling", description: "Completed AWS certification — a clear signal of your intent to grow." },
      { icon_letter: "C", title: "Career crossroads", description: "Ready to move from service-based to product company and AI-driven roles." },
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
    coverMessage: assetData.coverMessage,
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


async function renderPdf(assetData, strategy, leadProfile) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // A4 Landscape
  const W = 841;
  const H = 595;
  const M = 40; // margin

  // Color palette
  const navy   = rgb(14/255, 34/255, 56/255);
  const blue   = rgb(26/255, 58/255, 107/255);
  const white  = rgb(1, 1, 1);
  const light  = rgb(245/255, 247/255, 251/255);
  const bodyTxt = rgb(26/255, 26/255, 46/255);
  const gray   = rgb(107/255, 114/255, 128/255);
  const orange = rgb(232/255, 83/255, 26/255);
  const chipBg = rgb(232/255, 240/255, 254/255);
  const chipTx = rgb(26/255, 58/255, 107/255);
  const green  = rgb(52/255, 168/255, 83/255);
  const cardBg = rgb(248/255, 249/255, 252/255);

  // ── helpers ──────────────────────────────────────────────────────────────
  function r(page, x, y, w, h, color) {
    page.drawRectangle({ x, y, width: w, height: h, color });
  }
  function ctr(page, txt, x, avail, y, size, f, color) {
    const tw = f.widthOfTextAtSize(txt, size);
    page.drawText(txt, { x: x + Math.max(0, (avail - tw) / 2), y, size, font: f, color });
  }
  function circ(page, cx, cy, radius, color) {
    page.drawCircle({ x: cx, y: cy, size: radius, color });
  }
  function iconCircle(page, cx, cy, radius, letter, bg, fg) {
    circ(page, cx, cy, radius, bg);
    const s = Math.max(6, radius * 0.75);
    const tw = bold.widthOfTextAtSize(letter, s);
    page.drawText(letter, { x: cx - tw / 2, y: cy - s * 0.38, size: s, font: bold, color: fg });
  }
  function pill(page, x, y, txt, f, size = 9) {
    const tw = f.widthOfTextAtSize(txt, size);
    const pw = tw + 14; const ph = size + 7;
    r(page, x, y, pw, ph, chipBg);
    page.drawText(txt, { x: x + 7, y: y + 4, size, font: f, color: chipTx });
    return pw;
  }
  function slideHeader(page, num, title, sub) {
    const bsz = 32;
    r(page, M, H - M - bsz, bsz, bsz, navy);
    ctr(page, num, M, bsz, H - M - bsz + 9, 13, bold, white);
    page.drawText(title, { x: M + bsz + 10, y: H - M - 22, size: 18, font: bold, color: bodyTxt });
    if (sub) page.drawText(sub, { x: M + bsz + 10, y: H - M - 38, size: 10, font, color: gray });
  }
  function pageNum(page, n) {
    const tw = font.widthOfTextAtSize(String(n), 9);
    page.drawText(String(n), { x: W - M - tw, y: 14, size: 9, font, color: gray });
  }

  // ── mountain illustration ─────────────────────────────────────────────────
  function drawMountain(page, ox, oy, w, h) {
    const baseY = oy + h * 0.12;
    const peakX = ox + w * 0.52;
    const peakY = oy + h * 0.82;
    const sm1X  = ox + w * 0.28;
    const sm1Y  = oy + h * 0.58;
    // large mountain
    page.drawLine({ start: {x: ox + w*0.08, y: baseY}, end: {x: peakX, y: peakY}, thickness: 2, color: navy });
    page.drawLine({ start: {x: ox + w*0.92, y: baseY}, end: {x: peakX, y: peakY}, thickness: 2, color: navy });
    // small left peak
    page.drawLine({ start: {x: ox + w*0.05, y: baseY}, end: {x: sm1X, y: sm1Y}, thickness: 1.5, color: blue });
    page.drawLine({ start: {x: ox + w*0.46, y: baseY}, end: {x: sm1X, y: sm1Y}, thickness: 1.5, color: blue });
    // path dots
    const pts = [
      [ox + w*0.24, baseY + h*0.04],
      [ox + w*0.33, baseY + h*0.16],
      [ox + w*0.40, baseY + h*0.28],
      [ox + w*0.46, baseY + h*0.44],
      [peakX, peakY],
    ];
    for (const [px, py] of pts) circ(page, px, py, 4, navy);
    // flag pole + flag
    page.drawLine({ start: {x: peakX, y: peakY}, end: {x: peakX, y: peakY + 22}, thickness: 1.5, color: navy });
    r(page, peakX, peakY + 12, 14, 10, orange);
    // person (stick figure)
    const px2 = ox + w*0.76, py2 = baseY + h*0.06;
    circ(page, px2, py2 + 13, 5, blue);
    page.drawLine({ start: {x: px2, y: py2+8}, end: {x: px2, y: py2-4}, thickness: 1.5, color: blue });
    page.drawLine({ start: {x: px2-5, y: py2+2}, end: {x: px2+5, y: py2+2}, thickness: 1.5, color: blue });
    page.drawLine({ start: {x: px2, y: py2-4}, end: {x: px2-4, y: py2-12}, thickness: 1.5, color: blue });
    page.drawLine({ start: {x: px2, y: py2-4}, end: {x: px2+4, y: py2-12}, thickness: 1.5, color: blue });
    // horizon line
    page.drawLine({ start: {x: ox, y: baseY}, end: {x: ox+w, y: baseY}, thickness: 0.5, color: chipBg });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SLIDE 1 — COVER
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    const leftW = 290;
    r(pg, 0, 0, leftW, H, navy);
    r(pg, leftW, 0, W - leftW, H, light);

    // logo
    pg.drawText("SCALER", { x: M, y: H - M - 6, size: 15, font: bold, color: white });
    r(pg, M + bold.widthOfTextAtSize("SCALER", 15) + 4, H - M - 6, 10, 12, orange);

    // hero headline
    let hy = H - M - 58;
    for (const line of ["Your Personalized", "Career Plan"]) {
      pg.drawText(line, { x: M, y: hy, size: 24, font: bold, color: white });
      hy -= 30;
    }
    // tagline
    hy -= 6;
    for (const line of wrapText(assetData.subtitle || "Built for your goals. Backed by real outcomes.", font, 10, leftW - M * 2)) {
      pg.drawText(line, { x: M, y: hy, size: 10, font, color: rgb(0.82,0.82,0.82) });
      hy -= 14;
    }
    // prepared for
    hy -= 16;
    pg.drawText("Prepared for", { x: M, y: hy, size: 9, font, color: rgb(0.65,0.65,0.65) });
    hy -= 20;
    pg.drawText(leadProfile.name, { x: M, y: hy, size: 16, font: bold, color: white });
    hy -= 18;
    const roleExp = [leadProfile.role, leadProfile.experience].filter(Boolean).join("  •  ");
    if (roleExp) {
      for (const line of wrapText(roleExp, font, 9, leftW - M * 2)) {
        pg.drawText(line, { x: M, y: hy, size: 9, font, color: rgb(0.72,0.72,0.72) });
        hy -= 13;
      }
    }
    // "Based on your conversation" note
    hy -= 14;
    pg.drawText("Based on your conversation", { x: M, y: hy, size: 8, font, color: rgb(0.55,0.55,0.55) });
    hy -= 11;
    pg.drawText("with your Scaler BDA", { x: M, y: hy, size: 8, font, color: rgb(0.55,0.55,0.55) });

    // CTA card at bottom
    const ctaBoxY = 30, ctaBoxH = 72, ctaBoxW = leftW - M * 2;
    r(pg, M, ctaBoxY, ctaBoxW, ctaBoxH, rgb(1,1,1));
    r(pg, M, ctaBoxY, 3, ctaBoxH, orange);
    pg.drawText("Next Step", { x: M + 12, y: ctaBoxY + ctaBoxH - 18, size: 10, font: bold, color: navy });
    for (const line of wrapText("Take the assessment to unlock the right path for you.", font, 8, ctaBoxW - 20)) {
      pg.drawText(line, { x: M + 12, y: ctaBoxY + ctaBoxH - 33, size: 8, font, color: gray });
    }

    // mountain
    drawMountain(pg, leftW + 10, 30, W - leftW - 20, H - 60);
    pageNum(pg, 1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SLIDE 2 — WHERE YOU STAND TODAY
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "01", "Where You Stand Today", "A snapshot of your current situation");

    const items = (assetData.situationItems || []).slice(0, 5);
    const startY = H - M - 75;
    const itemH  = Math.min(90, (startY - M - 20) / Math.max(items.length, 1));
    const textX  = M + 50;
    const textW  = W - textX - M;

    items.forEach((item, i) => {
      const iy = startY - i * itemH;
      const letter = (item.icon_letter || item.title.charAt(0)).toUpperCase().substring(0,2);
      iconCircle(pg, M + 20, iy - 6, 16, letter, item.is_good_news ? rgb(0.9,0.97,0.92) : light, item.is_good_news ? green : blue);
      pg.drawText(item.title, { x: textX, y: iy, size: 11, font: bold, color: bodyTxt });
      let dy = iy - 14;
      for (const ln of wrapText(item.description || "", font, 9, textW).slice(0, 3)) {
        pg.drawText(ln, { x: textX, y: dy, size: 9, font, color: gray });
        dy -= 12;
      }
      if (i < items.length - 1)
        pg.drawLine({ start: {x: textX, y: iy - itemH + 10}, end: {x: W - M, y: iy - itemH + 10}, thickness: 0.5, color: chipBg });
    });
    pageNum(pg, 2);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SLIDE 3 — YOUR GOALS
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "02", "Your Goals", "What you want to achieve next");

    const goals = (assetData.goals || []).slice(0, 3);
    const cardsY = H - M - 75;
    const cardW  = Math.floor((W - M * 2 - 24) / 3);
    const cardH  = 120;

    goals.forEach((goal, i) => {
      const cx = M + i * (cardW + 12);
      r(pg, cx, cardsY - cardH, cardW, cardH, light);
      const letter = (goal.icon_letter || goal.title.charAt(0)).toUpperCase().substring(0,2);
      iconCircle(pg, cx + cardW / 2, cardsY - 24, 16, letter, blue, white);
      const tLines = wrapText(goal.title, bold, 10, cardW - 12).slice(0, 2);
      let ty = cardsY - 52;
      for (const l of tLines) { ctr(pg, l, cx, cardW, ty, 10, bold, bodyTxt); ty -= 13; }
      for (const l of wrapText(goal.description || "", font, 8, cardW - 12).slice(0, 3)) {
        ctr(pg, l, cx, cardW, ty, 8, font, gray); ty -= 11;
      }
    });

    // Role pills
    let ry = cardsY - cardH - 22;
    pg.drawText("Roles you are targeting", { x: M, y: ry, size: 10, font: bold, color: bodyTxt });
    ry -= 18;
    let pillX = M;
    for (const role of (assetData.targetRoles || [])) {
      const pw = font.widthOfTextAtSize(role, 9) + 14;
      if (pillX + pw > W - M) { pillX = M; ry -= 22; }
      pill(pg, pillX, ry, role, font, 9);
      pillX += pw + 8;
    }

    // Pull quote
    ry -= 36;
    if (assetData.pullQuote && ry > M + 20) {
      pg.drawText("\u201C", { x: M, y: ry, size: 20, font: bold, color: navy });
      let qy = ry - 2;
      for (const l of wrapText(assetData.pullQuote, font, 9, W - M * 2 - 22).slice(0, 2)) {
        pg.drawText(l, { x: M + 18, y: qy, size: 9, font, color: bodyTxt }); qy -= 13;
      }
    }
    pageNum(pg, 3);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SLIDE 4 — YOUR KEY QUESTIONS, ANSWERED
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "03", "Your Key Questions, Answered", "Honest answers to what matters most to you");

    const qas = (assetData.questionsAnswered || []).slice(0, 3);
    const startY = H - M - 80;
    const qaH    = Math.min(110, (startY - M - 60) / Math.max(qas.length, 1));

    qas.forEach((qa, i) => {
      const qy = startY - i * qaH;
      const letter = (qa.icon_letter || "Q").toUpperCase().substring(0,2);
      iconCircle(pg, M + 18, qy - 6, 16, letter, light, blue);
      pg.drawCircle({ x: M+18, y: qy-6, size: 16, borderColor: chipBg, borderWidth: 1 });
      const qLines = wrapText(`"${qa.question}"`, bold, 10, W - M * 2 - 48).slice(0, 2);
      let ty = qy;
      for (const l of qLines) { pg.drawText(l, { x: M+44, y: ty, size: 10, font: bold, color: bodyTxt }); ty -= 13; }
      for (const l of wrapText(qa.answer || "", font, 9, W - M * 2 - 48).slice(0, 3)) {
        pg.drawText(l, { x: M+44, y: ty, size: 9, font, color: gray }); ty -= 12;
      }
      if (i < qas.length - 1)
        pg.drawLine({ start: {x: M, y: qy - qaH + 10}, end: {x: W-M, y: qy - qaH + 10}, thickness: 0.5, color: chipBg });
    });

    // Bottom line box
    if (assetData.bottomLine) {
      const blH = 42;
      r(pg, M, M + 4, W - M * 2, blH, navy);
      pg.drawText("Bottom line", { x: M+12, y: M + blH - 10, size: 9, font: bold, color: orange });
      for (const l of wrapText(assetData.bottomLine, font, 9, W - M * 2 - 24).slice(0, 2)) {
        pg.drawText(l, { x: M+12, y: M + blH - 24, size: 9, font, color: rgb(0.88,0.88,0.88) });
      }
    }
    pageNum(pg, 4);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SLIDE 5 — WHY SCALER IS THE RIGHT FIT
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "04", "Why Scaler is the Right Fit for You", "Designed for engineers. Built for outcomes.");

    const features = (assetData.whyScalerFeatures || []).slice(0, 6);
    const cols = 2, rows = Math.ceil(features.length / cols);
    const fW   = Math.floor((W - M * 2 - 16) / cols);
    const fH   = 68;
    const startY = H - M - 75;

    features.forEach((feat, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const fx = M + col * (fW + 16);
      const fy = startY - row * (fH + 8) - fH;
      const letter = (feat.icon_letter || feat.title.charAt(0)).toUpperCase().substring(0,2);
      iconCircle(pg, fx + 20, fy + fH - 20, 14, letter, light, blue);
      pg.drawText(feat.title, { x: fx + 40, y: fy + fH - 16, size: 10, font: bold, color: bodyTxt });
      let dy = fy + fH - 30;
      for (const l of wrapText(feat.description || "", font, 8, fW - 44).slice(0, 2)) {
        pg.drawText(l, { x: fx + 40, y: dy, size: 8, font, color: gray }); dy -= 11;
      }
    });

    // Stats bar
    const barH = 52;
    r(pg, 0, 0, W, barH, navy);
    const stats = [["1500+", "careers accelerated"], ["85%+", "of learners make a career shift"]];
    stats.forEach(([val, lbl], i) => {
      const sx = M + i * (W / 2);
      pg.drawText(val, { x: sx, y: barH - 20, size: 18, font: bold, color: white });
      pg.drawText(lbl, { x: sx, y: barH - 34, size: 8, font, color: rgb(0.7,0.7,0.7) });
      if (i === 0) pg.drawLine({ start: {x: W/2, y: 8}, end: {x: W/2, y: barH - 6}, thickness: 0.5, color: rgb(0.3,0.4,0.5) });
    });
    pg.drawText("*Based on internal data", { x: W - M - font.widthOfTextAtSize("*Based on internal data", 7), y: 6, size: 7, font, color: rgb(0.5,0.5,0.5) });
    pageNum(pg, 5);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SLIDE 6 — YOUR NEXT STEP
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "05", "Your Next Step", "A small step today for a big leap tomorrow.");

    const colW  = (W - M * 2 - 24) / 2;
    const leftX = M, rightX = M + colW + 24;
    const topY  = H - M - 82;

    // Left: Assessment card
    const cardH = 220;
    r(pg, leftX, topY - cardH, colW, cardH, rgb(235/255, 244/255, 255/255));
    // clipboard icon (rect + lines)
    r(pg, leftX + 14, topY - 30, 28, 22, blue);
    for (let li = 0; li < 3; li++) {
      pg.drawLine({ start: {x: leftX+19, y: topY - 36 - li*5}, end: {x: leftX+36, y: topY - 36 - li*5}, thickness: 1, color: white });
    }
    pg.drawText(assetData.nextStepTitle || "Take the Assessment", { x: leftX + 50, y: topY - 22, size: 12, font: bold, color: navy });
    let ay = topY - 38;
    for (const l of wrapText(assetData.nextStepBody || "", font, 9, colW - 16).slice(0, 3)) {
      pg.drawText(l, { x: leftX + 12, y: ay, size: 9, font, color: gray }); ay -= 13;
    }
    // feature pills row
    ay -= 12;
    const fpills = ["Personalized feedback", "Right batch recommendation", "Clarity on your readiness"];
    let fpillX = leftX + 12;
    for (const fp of fpills) {
      const fw = font.widthOfTextAtSize(fp, 7) + 10;
      if (fpillX + fw > leftX + colW - 8) { fpillX = leftX + 12; ay -= 20; }
      r(pg, fpillX, ay, fw, 16, chipBg);
      pg.drawText(fp, { x: fpillX + 5, y: ay + 4, size: 7, font, color: chipTx });
      fpillX += fw + 6;
    }

    // Right: Why take it checklist
    pg.drawText("Why take it?", { x: rightX, y: topY, size: 12, font: bold, color: bodyTxt });
    let cy = topY - 22;
    for (const item of (assetData.whyTakeIt || []).slice(0, 4)) {
      circ(pg, rightX + 8, cy + 4, 7, rgb(0.9, 0.97, 0.92));
      pg.drawText("v", { x: rightX + 5, y: cy + 1, size: 7, font: bold, color: green });
      for (const l of wrapText(item, font, 9, colW - 30).slice(0, 1)) {
        pg.drawText(l, { x: rightX + 22, y: cy, size: 9, font, color: bodyTxt });
      }
      cy -= 22;
    }

    // Footer bar
    const footH = 46;
    r(pg, 0, 0, W, footH, navy);
    pg.drawText("We're excited to be part of your journey.", { x: M, y: footH - 18, size: 10, font: bold, color: white });
    pg.drawText("Let's build the future, together.", { x: M, y: footH - 32, size: 9, font, color: rgb(0.75,0.75,0.75) });
    pg.drawText("SCALER", { x: W - M - bold.widthOfTextAtSize("SCALER", 14), y: footH - 22, size: 14, font: bold, color: white });
    r(pg, W - M - bold.widthOfTextAtSize("SCALER", 14) - 14, footH - 22, 10, 13, orange);
    pageNum(pg, 6);
  }

  return await pdfDoc.save();
}




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

  const params = new URLSearchParams();
  params.set("To", `whatsapp:${to}`);
  params.set("From", process.env.TWILIO_WHATSAPP_FROM);
  params.set("Body", body);
  if (mediaUrl) params.set("MediaUrl", mediaUrl);

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

async function uploadPdfToSupabase(assetId, pdfBytes) {
  const fileName = `${assetId}.pdf`;
  const { error } = await supabase.storage
    .from("pdfs")
    .upload(fileName, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (error) throw error;

  const { data } = supabase.storage.from("pdfs").getPublicUrl(fileName);
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
