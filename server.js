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

const supabase = createClient(
  process.env.SUPABASE_URL || "",
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
    
    // Supabase Integration: Save lead and upload PDF
    const lead = await saveLeadToSupabase(leadProfile);
    const pdfUrl = await uploadPdfToSupabase(assetId, generated.pdfBytes);

    generatedAssets.set(assetId, {
      id: assetId,
      createdAt: new Date().toISOString(),
      leadId: lead.id,
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
    "You are creating a comprehensive, highly personalized 2-3 page post-call Scaler follow-up PDF.",
    "Requirements:",
    "1. Address each of the lead's explicit and implicit questions specifically, using grounded evidence (curriculum detail, alumni outcomes, ROI reasoning).",
    "2. Frame Scaler's strength entirely through the lens of this lead's specific goals. No generic marketing.",
    "3. The output must be visibly unique to this lead's situation and tone.",
    "4. Generate at least 5 to 7 detailed sections to ensure a robust 2-3 page document.",
    "5. Use only grounded evidence provided. Do not include an explicit 'Evidence' section; weave it naturally.",
    "Return JSON with keys:",
    "cover_message (short personalized WhatsApp message), hero_title (uppercase, highly specific to lead), subtitle, goal_summary (e.g. 'TCS Software Engineer -> Product Company AI Engineer'), sections (array of 5-7 {heading, body, bullets}), next_step_title, next_step_body.",
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
        heroTitle: typeof parsed.hero_title === "string" ? parsed.hero_title : fallback.heroTitle,
        subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : fallback.subtitle,
        goalSummary: typeof parsed.goal_summary === "string" ? parsed.goal_summary : fallback.goalSummary,
        sections: Array.isArray(parsed.sections) && parsed.sections.length
          ? parsed.sections
          : fallback.sections,
        nextStepTitle:
          typeof parsed.next_step_title === "string"
            ? parsed.next_step_title
            : fallback.nextStepTitle,
        nextStepBody:
          typeof parsed.next_step_body === "string"
            ? parsed.next_step_body
            : fallback.nextStepBody,
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
  if (strategy.key === "senior-operator") {
    return {
      coverMessage: `Hi ${leadProfile.name.split(" ")[0]}, sharing a concise summary tailored to the questions you raised around applied depth, instructor credibility, and cohort quality. I've kept it focused on what appears grounded from Scaler's public material.`,
      heroTitle: "APPLIED AI FOR SENIOR ENGINEERS",
      subtitle:
        "A practical read on where structured, evaluated execution may matter more than more theory.",
      goalSummary: "Senior Software Engineer -> Applied AI Expert",
      sections: [
        {
          heading: "Your bar is already high",
          body:
            "You are not evaluating Scaler from a beginner mindset. The real question is whether a program adds applied leverage that is hard to recreate from papers, internal docs, and solo exploration.",
          bullets: [
            "You already understand fundamentals and can read technical material independently.",
            "The bar for value is production relevance, not content volume.",
          ],
        },
        {
          heading: "Where Scaler appears differentiated",
          body:
            "The strongest grounded signals are around evaluated projects, AI-integrated workflows, and guidance from practitioners who are actively building in the industry.",
          bullets: [
            "Projects and AI labs are described as integrated into learning, not bolted on later.",
            "Mentors are framed as active industry professionals rather than purely academic instructors.",
            "The homepage explicitly mentions building and shipping production AI systems as part of the program's GenAI specialization.",
          ],
        },
        {
          heading: "Questions still worth pressure-testing live",
          body:
            "Some of the highest-value decisions still need a direct follow-up with the BDA or an advisor because they cannot be responsibly inferred from the website alone.",
          bullets: [
            "Exact seniority mix of the cohort you would join.",
            "Specific instructor roster for the current cohort and their production AI background.",
            "How much of the work is genuinely peer-level versus foundational refresh.",
          ],
        },
        {
          heading: "The cohort quality argument",
          body:
            "For someone at your level, the single biggest risk of a structured program is that the peer group is too junior. Ask directly: what is the median YOE of your batch, and how do they filter for seniority?",
          bullets: [
            "Scaler positions the cohort as a filter for serious practitioners, not a mass enrollment.",
            "Ask for one example of a real peer-level technical discussion or code review from a recent cohort.",
            "Network value accrues over years — who you learn alongside matters as much as what you learn.",
          ],
        },
        {
          heading: "Production AI: what the curriculum actually covers",
          body:
            "Based on the homepage and GenAI specialization page, the program explicitly covers building, evaluating, and shipping production AI systems — RAG pipelines, LLM evals, and applied agent frameworks. This is different from theory-first ML.",
          bullets: [
            "GenAI specialization is described as focused on shipping, not just studying.",
            "AI labs are module-by-module, not a single capstone bolted at the end.",
            "Curriculum is updated quarterly, which matters for fast-moving AI tooling.",
          ],
        },
        {
          heading: "How to evaluate this honestly",
          body:
            "The right way to evaluate a program at your level is not through a sales call. Ask for a 30-minute walkthrough of one module, one real project brief, and one mentor profile. If those pass your bar, the rest is worth exploring seriously.",
          bullets: [
            "Concrete ask: show me one applied AI lab brief and its evaluation rubric.",
            "Concrete ask: introduce me to one mentor currently building production AI systems.",
            "Concrete ask: what percentage of your current cohort has 7+ years of experience?",
          ],
        },
      ],
      nextStepTitle: "Recommended next step",
      nextStepBody:
        "If you continue the evaluation, ask for one concrete walkthrough of an applied AI project, one example of how feedback is delivered, and one honest explanation of who in the cohort gets the most value.",
    };
  }

  if (strategy.key === "career-risk") {
    return {
      coverMessage: `Hi ${leadProfile.name.split(" ")[0]}, sharing the note I promised. I wrote this to help with the real decision underneath your questions: whether this path feels credible enough to discuss with your family and worth taking seriously for your career.`,
      heroTitle: "YOUR PRODUCT COMPANY CAREER BEGINS",
      subtitle:
        "Not a promise sheet. A grounded summary of what seems real, what still needs confirmation, and how to frame the risk.",
      goalSummary: "Final Year Student -> Product Company Role",
      sections: [
        {
          heading: "Your decision is bigger than a course",
          body:
            "You are comparing certainty today with the possibility of a different long-term career. That means emotional safety and family confidence matter just as much as curriculum details.",
          bullets: [
            "A secure offer has real value, especially when family finances are tight.",
            "Any decision here should be based on clear support structures, not hype.",
          ],
        },
        {
          heading: "What Scaler seems able to support",
          body:
            "The public material emphasizes structured curriculum, mentorship, mock interviews, and career support. Those are useful because they reduce ambiguity when someone is early in their journey.",
          bullets: [
            "Structured path through fundamentals, projects, and interview preparation.",
            "1:1 mentorship and mock interview support are described on the Academy page.",
            "Career support and a large learner/alumni network are highlighted on the homepage.",
          ],
        },
        {
          heading: "What should be confirmed before any family decision",
          body:
            "There are a few things no responsible summary should guess, and those are exactly the questions to take back to the BDA.",
          bullets: [
            "No one should guarantee a job outcome from public website claims alone.",
            "Specific financing options need to be shared by the team directly.",
            "The entrance test process and how it is interpreted should be clarified with precision.",
          ],
        },
        {
          heading: "The entrance test: what it actually means",
          body:
            "Feeling nervous about a screening is normal. The entrance assessment is a readiness checkpoint — it helps Scaler place you correctly and helps you understand where to focus first.",
          bullets: [
            "Ask the BDA: what percentage of first-time applicants pass the entrance test?",
            "Ask: what happens if I don't clear it the first time? Is there a retry path?",
            "The test is a fit signal, not a judgment of your potential.",
          ],
        },
        {
          heading: "How the financing actually works",
          body:
            "₹3.5L is a significant decision and your family deserves written clarity on every term before any commitment is made. Ask for the financing breakdown in writing.",
          bullets: [
            "Ask for a written breakdown of every option: upfront, EMI, ISA, or deferred.",
            "Understand the terms: what counts as a qualifying job, and what happens if placement takes longer.",
            "No decision that affects family finances should be made under call pressure.",
          ],
        },
        {
          heading: "The government offer is not the only safe path",
          body:
            "Stability and career growth are not mutually exclusive. The right question is not which path is safer — it is which gives you the best chance at the career you actually want.",
          bullets: [
            "Government jobs offer stability but limited compensation growth for tech-oriented careers.",
            "Product company roles offer higher variance but significantly better long-term trajectory.",
            "You do not have to decide today — but you need the financing and placement terms in writing first.",
          ],
        },
      ],
      nextStepTitle: "Before you decide anything",
      nextStepBody:
        "Get written answers to three things: the exact financing terms available to you, the entrance test retry policy, and what career support looks like after the program ends. With those in hand you will be able to have an honest conversation with your family.",
    };
  }

  return {
    coverMessage: `Hi ${leadProfile.name.split(" ")[0]}, sharing a personalized summary from our call. I focused this on the jump you want to make, the questions you raised about ROI and practical AI depth, and the areas that seem grounded from Scaler's public material.`,
    heroTitle: "YOUR PATH TO PRODUCT & AI ROLES",
    subtitle:
      "A direct summary of what appears useful, where the structure may help, and what still needs a precise follow-up.",
    goalSummary: "Service Software Engineer -> Product Company AI Engineer",
    sections: [
      {
        heading: "What you are trying to change",
        body:
          "This is not just about learning more content. It is about changing the type of work you can credibly do next and making sure the time and money invested actually move your career forward.",
        bullets: [
          "You want more product-oriented, applied engineering work.",
          "You care whether the upside is meaningful enough to justify the cost.",
        ],
      },
      {
        heading: "What Scaler appears to emphasize",
        body:
          "The strongest public signals are around structured depth, evaluated practice, mentorship, and AI-specialized execution rather than passive lecture consumption.",
        bullets: [
          "AI-integrated curriculum with updates described as ongoing.",
          "Generative AI specialization on the homepage mentions building, evaluating, and shipping production AI systems.",
          "Projects and AI labs are described as part of the learning flow.",
        ],
      },
      {
        heading: "How to think about the free-vs-paid question",
        body:
          "Free content can absolutely teach concepts. The argument for a program has to be about structure, feedback, practical execution, and accountability. If those are not meaningfully stronger, the premium is hard to justify.",
        bullets: [
          "Use Scaler only if the applied workflow and review loop are genuinely stronger for your use case.",
          "Ask for concrete examples of projects and mentor feedback before deciding.",
        ],
      },
      {
        heading: "ROI: the salary math done honestly",
        body:
          "Going from service work to a product company at the right salary tier is not just an increment — it is a category change. The ROI is in compounding trajectory, not just the next offer letter.",
        bullets: [
          "Scaler's 2024 cohort outcomes are reported on the homepage — treat them as signals, not personal promises.",
          "If the program accelerates your product-company transition by 18 months, the lifetime earning difference dwarfs the program cost.",
          "The honest caveat: outcomes depend on your execution during and after the program, not just enrollment.",
        ],
      },
      {
        heading: "What you would actually build",
        body:
          "The GenAI specialization described on Scaler's homepage covers RAG pipelines, LLM evaluation frameworks, and agent-based architectures — the exact stack that product companies are hiring for right now.",
        bullets: [
          "RAG systems: retrieval-augmented generation pipelines powering real production search and Q&A products.",
          "LLM evals: building evaluation harnesses to measure and improve model outputs.",
          "Agent frameworks: multi-step reasoning systems that connect LLMs to tools and APIs.",
          "AI labs are module-by-module — you build throughout the program, not just at the end.",
        ],
      },
      {
        heading: "Mentor and peer quality: what to verify",
        body:
          "The weakest part of any structured program is when mentors are academics or peers are too junior. These are worth verifying directly before you commit.",
        bullets: [
          "Ask: who are the specific mentors for the AI Engineering track, and what have they shipped recently?",
          "Ask: what is the median years of experience of learners in the current cohort?",
          "Ask: can I speak to one alumnus who transitioned from a similar service company background?",
        ],
      },
    ],
    nextStepTitle: "What to do next",
    nextStepBody:
      "Ask for one concrete example of the type of applied AI project you would build, one truthful explanation of typical learner outcomes, and one precise answer on where the program adds leverage beyond free resources.",
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

function renderPreviewHtml(assetData, strategy, leadProfile, evidence) {
  const [primary, secondary, surface] = strategy.palette;
  const sectionsHtml = assetData.sections
    .map(
      (section) => `
        <section class="preview-section">
          <h3>${escapeHtml(section.heading)}</h3>
          <p>${escapeHtml(section.body)}</p>
          ${
            section.bullets?.length
              ? `<ul>${section.bullets
                  .map((bullet) => `<li>${escapeHtml(bullet)}</li>`)
                  .join("")}</ul>`
              : ""
          }
        </section>
      `
    )
    .join("");

  return `
    <div class="pdf-preview-shell" style="--primary:${primary};--secondary:${secondary};--surface:${surface}">
      <header class="pdf-preview-hero">
        <p class="eyebrow">${escapeHtml(strategy.heroLabel)}</p>
        <h1>${escapeHtml(assetData.heroTitle)}</h1>
        <p class="subtitle">${escapeHtml(assetData.subtitle)}</p>
        <div class="identity">
          <span>${escapeHtml(leadProfile.name)}</span>
          <span>${escapeHtml(leadProfile.role || "Lead profile")}</span>
          <span>${escapeHtml(leadProfile.experience || "Experience not provided")}</span>
        </div>
      </header>
      <main>${sectionsHtml}</main>
      <section class="preview-section">
        <h3>${escapeHtml(assetData.nextStepTitle)}</h3>
        <p>${escapeHtml(assetData.nextStepBody)}</p>
      </section>
    </div>
  `;
}

async function renderPdf(assetData, strategy, leadProfile) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Scaler Brand Colors
  const primary = rgb(14 / 255, 34 / 255, 56 / 255);    // #0e2238 (Dark Navy)
  const secondary = rgb(25 / 255, 60 / 255, 100 / 255); // Slightly lighter navy
  const scalerOrange = rgb(1, 0.42, 0.13);              // #FF6B22
  const ctaYellow = rgb(245 / 255, 185 / 255, 66 / 255); // #F5B942 (Warm Yellow)
  const white = rgb(1, 1, 1);
  const darkText = rgb(0.1, 0.1, 0.1);
  const cardBg = rgb(0.95, 0.96, 0.98); // Very light blue/grey
  const cardStroke = rgb(0.85, 0.88, 0.92);

  const W = 430;   // iPhone Pro Max width
  const H = 932;   // iPhone Pro Max height
  const MARGIN = 24;
  const CONTENT_W = W - MARGIN * 2;

  function newPage(pageNum) {
    const pg = pdfDoc.addPage([W, H]);
    // Top subtle bar
    drawRect(pg, 0, H - 4, W, 4, primary);
    // Footer
    drawRect(pg, 0, 0, W, 24, cardBg);
    pg.drawText("SCALER", { x: MARGIN, y: 8, size: 8, font: bold, color: scalerOrange });
    pg.drawText(`Personalized for ${leadProfile.name}`, { x: MARGIN + 45, y: 8, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
    pg.drawText(`Page ${pageNum}`, { x: W - MARGIN - 24, y: 8, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
    return pg;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PAGE 1 — Cover / Hero
  // ──────────────────────────────────────────────────────────────────────────
  let page = pdfDoc.addPage([W, H]);
  let pageNum = 1;

  // Full-bleed dark hero background
  const heroHeight = 260;
  drawRect(page, 0, H - heroHeight, W, heroHeight, primary);

  // Top header with Logo & Name
  page.drawText("SCALER", { x: MARGIN, y: H - 36, size: 14, font: bold, color: white });
  const nameW = font.widthOfTextAtSize(leadProfile.name, 10);
  page.drawText(leadProfile.name, { x: W - MARGIN - nameW, y: H - 34, size: 10, font, color: rgb(0.8, 0.8, 0.8) });

  // Hero Title
  const heroLines = wrapText(assetData.heroTitle, bold, 26, CONTENT_W);
  let heroY = H - 90;
  for (const line of heroLines) {
    page.drawText(line, { x: MARGIN, y: heroY, size: 26, font: bold, color: white });
    heroY -= 30;
  }

  // Gold accent bar under title
  heroY -= 10;
  drawRect(page, MARGIN, heroY, 60, 4, ctaYellow);

  // Subtitle
  heroY -= 20;
  const subLines = wrapText(assetData.subtitle || "", font, 12, CONTENT_W - 20);
  for (const line of subLines) {
    page.drawText(line, { x: MARGIN, y: heroY, size: 12, font, color: rgb(0.85, 0.85, 0.85) });
    heroY -= 16;
  }

  // ── The "Goal" Box ────────────────────────────────────────────────────────
  let y = H - heroHeight - 30;

  if (assetData.goalSummary) {
    page.drawText("Goal", { x: MARGIN, y, size: 14, font: bold, color: darkText });
    y -= 14;

    const goalLines = wrapText(assetData.goalSummary, bold, 14, CONTENT_W - 24);
    const goalBoxH = 24 + goalLines.length * 18;
    y -= goalBoxH;

    // Draw light blue goal box with border
    drawRect(page, MARGIN, y, CONTENT_W, goalBoxH, cardBg);
    page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: goalBoxH, borderColor: cardStroke, borderWidth: 1 });
    
    let gTextY = y + goalBoxH - 22;
    for (const gLine of goalLines) {
      page.drawText(gLine, { x: MARGIN + 12, y: gTextY, size: 14, font: bold, color: darkText });
      gTextY -= 18;
    }
    y -= 40;
  } else {
    y -= 10;
  }

  // Footer on page 1
  drawRect(page, 0, 0, W, 24, cardBg);
  page.drawText("SCALER", { x: MARGIN, y: 8, size: 8, font: bold, color: scalerOrange });
  page.drawText(`Personalized for ${leadProfile.name}`, { x: MARGIN + 45, y: 8, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
  page.drawText(`Page 1`, { x: W - MARGIN - 24, y: 8, size: 7, font, color: rgb(0.5, 0.5, 0.5) });

  // ──────────────────────────────────────────────────────────────────────────
  // Sections (Card style)
  // ──────────────────────────────────────────────────────────────────────────
  for (const section of assetData.sections) {
    const bodyLines = wrapText(section.body || "", font, 11, CONTENT_W - 24);
    const bulletLines = (section.bullets || []).flatMap((b) => wrapText(`• ${b}`, font, 11, CONTENT_W - 36));
    
    // Header height (30), body padding top/bottom (30), body lines, bullet lines
    const cardH = 34 + 16 + (bodyLines.length * 15) + (bulletLines.length ? bulletLines.length * 15 + 10 : 0) + 16;

    if (y - cardH < 50) {
      pageNum++;
      page = newPage(pageNum);
      y = H - 50;
    }

    // Card Body Background
    drawRect(page, MARGIN, y - cardH, CONTENT_W, cardH, cardBg);
    page.drawRectangle({ x: MARGIN, y: y - cardH, width: CONTENT_W, height: cardH, borderColor: cardStroke, borderWidth: 1 });

    // Card Navy Header
    drawRect(page, MARGIN, y - 34, CONTENT_W, 34, primary);
    const headLines = wrapText(section.heading.toUpperCase(), bold, 11, CONTENT_W - 24);
    page.drawText(headLines[0], { x: MARGIN + 12, y: y - 22, size: 11, font: bold, color: white });

    // Body Text
    let textY = y - 34 - 20;
    for (const line of bodyLines) {
      page.drawText(line, { x: MARGIN + 12, y: textY, size: 11, font, color: darkText });
      textY -= 15;
    }

    // Bullets
    if (bulletLines.length) {
      textY -= 8;
      for (const bLine of bulletLines) {
        page.drawText(bLine, { x: MARGIN + 16, y: textY, size: 11, font, color: darkText });
        textY -= 15;
      }
    }

    y = y - cardH - 24;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Big Yellow CTA Button
  // ──────────────────────────────────────────────────────────────────────────
  const ctaTitleLines = wrapText(assetData.nextStepTitle.toUpperCase(), bold, 14, CONTENT_W - 40);
  const ctaBodyLines = wrapText(assetData.nextStepBody, font, 11, CONTENT_W);
  const ctaTotalH = (ctaTitleLines.length * 18) + (ctaBodyLines.length * 15) + 60;

  if (y - ctaTotalH < 50) {
    pageNum++;
    page = newPage(pageNum);
    y = H - 50;
  }

  // Draw CTA Body
  let ctaY = y - 10;
  for (const line of ctaBodyLines) {
    const w = font.widthOfTextAtSize(line, 11);
    page.drawText(line, { x: (W - w) / 2, y: ctaY, size: 11, font, color: darkText });
    ctaY -= 15;
  }

  ctaY -= 15;
  const btnH = 48 + (ctaTitleLines.length - 1) * 18;
  drawRect(page, MARGIN, ctaY - btnH, CONTENT_W, btnH, ctaYellow);

  let btnTextY = ctaY - 28 + (ctaTitleLines.length > 1 ? 9 : 0);
  for (const line of ctaTitleLines) {
    const w = bold.widthOfTextAtSize(line, 14);
    page.drawText(line, { x: (W - w) / 2, y: btnTextY, size: 14, font: bold, color: primary });
    btnTextY -= 18;
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
