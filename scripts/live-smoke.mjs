import fs from "node:fs/promises";
import path from "node:path";
import "./../lib/load-env.js";
import {
  benchmarkPersonas,
  detectPersonaStrategy,
  extractInsights,
  generateLeadAsset,
  generatePrecallNudge,
  normalizeLeadProfile,
  selectEvidenceForInsights,
} from "../server.js";

const outputDir = path.join(process.cwd(), "tmp");
await fs.mkdir(outputDir, { recursive: true });

const rohan = benchmarkPersonas.find((persona) => persona.id === "rohan");
const meera = benchmarkPersonas.find((persona) => persona.id === "meera");

await runScenario(rohan, "rohan-live");
await runScenario(meera, "meera-live");

console.log(`Live smoke outputs written to ${outputDir}`);

async function runScenario(persona, slug) {
  const leadProfile = normalizeLeadProfile(persona);
  const strategy = detectPersonaStrategy({
    ...leadProfile,
    transcript: persona.transcript,
  });
  const insights = await extractInsights(leadProfile, persona.transcript, strategy);
  const evidence = selectEvidenceForInsights(insights);
  const precall = await generatePrecallNudge(leadProfile, insights, evidence, strategy);
  const asset = await generateLeadAsset({
    leadProfile,
    transcript: persona.transcript,
    insights,
    evidence,
    strategy,
  });

  await fs.writeFile(path.join(outputDir, `${slug}-precall.txt`), precall.message, "utf8");
  await fs.writeFile(path.join(outputDir, `${slug}-preview.html`), asset.previewHtml, "utf8");
  await fs.writeFile(path.join(outputDir, `${slug}.pdf`), Buffer.from(asset.pdfBytes));

  const summary = {
    lead: leadProfile.name,
    strategy: strategy.key,
    explicitQuestions: insights.explicit_questions,
    purchaseBarriers: insights.purchase_barriers,
    coverMessage: asset.coverMessage,
  };

  await fs.writeFile(
    path.join(outputDir, `${slug}-summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );
}
