import assert from "node:assert/strict";
import {
  benchmarkPersonas,
  buildFallbackInsights,
  detectPersonaStrategy,
  generateLeadAsset,
  generatePrecallNudge,
  normalizeLeadProfile,
  scalerEvidencePack,
  selectEvidenceForInsights,
} from "../server.js";

const rohan = normalizeLeadProfile(benchmarkPersonas.find((persona) => persona.id === "rohan"));
const meera = normalizeLeadProfile(benchmarkPersonas.find((persona) => persona.id === "meera"));

const rohanStrategy = detectPersonaStrategy(rohan);
const meeraStrategy = detectPersonaStrategy(meera);

assert.notEqual(rohanStrategy.key, meeraStrategy.key);
assert.ok(scalerEvidencePack.length >= 5);

const rohanInsights = buildFallbackInsights(rohan, benchmarkPersonas.find((persona) => persona.id === "rohan").transcript, rohanStrategy);
const meeraInsights = buildFallbackInsights(meera, benchmarkPersonas.find((persona) => persona.id === "meera").transcript, meeraStrategy);

assert.ok(rohanInsights.explicit_questions.length > 0);
assert.ok(meeraInsights.purchase_barriers.includes("financing"));

const rohanEvidence = selectEvidenceForInsights(rohanInsights);
const meeraEvidence = selectEvidenceForInsights(meeraInsights);

const rohanPrecall = await generatePrecallNudge(rohan, rohanInsights, rohanEvidence, rohanStrategy);
const meeraPrecall = await generatePrecallNudge(meera, meeraInsights, meeraEvidence, meeraStrategy);

assert.match(rohanPrecall.message, /Fact/);
assert.match(meeraPrecall.message, /Missing/);
assert.notEqual(rohanPrecall.openingLine, meeraPrecall.openingLine);

const leadAsset = await generateLeadAsset({
  leadProfile: meera,
  transcript: benchmarkPersonas.find((persona) => persona.id === "meera").transcript,
  insights: meeraInsights,
  evidence: meeraEvidence,
  strategy: meeraStrategy,
});

assert.ok(leadAsset.coverMessage.length > 30);
assert.ok(leadAsset.previewHtml.includes("Grounded source pack used"));
assert.ok(leadAsset.pdfBytes.length > 1000);

console.log("Smoke test passed");
