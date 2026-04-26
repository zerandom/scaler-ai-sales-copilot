import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import fs from "fs/promises";
import path from "path";

export async function renderPdf(assetData, strategy, leadProfile) {
  let templateName = "rohan.html";
  if (strategy.key === "senior-operator") templateName = "karthik.html";
  if (strategy.key === "career-risk") templateName = "meera.html";

  const templatePath = path.join(process.cwd(), "lib", "templates", templateName);
  let html = await fs.readFile(templatePath, "utf-8");

  html = html.replace(/{{PAGE1_HEADLINE}}/g, assetData.page1Headline || "");
  html = html.replace(/{{PAGE1_TAGLINE}}/g, assetData.page1Tagline || "");
  html = html.replace(/{{NAME}}/g, leadProfile.name || "Lead");
  html = html.replace(/{{ROLE}}/g, leadProfile.role ? `${leadProfile.role} at ${leadProfile.company || "Company"}` : "");

  let sitItems = "";
  if (templateName === "karthik.html") {
    sitItems = (assetData.situationItems || []).map(item => `
      <div class="sit-row ${item.is_good_news ? 'good-news' : ''}">
        <div class="sit-icon">${item.icon_letter || 'S'}</div>
        <div class="sit-text">
          <h4>${item.title}</h4>
          <p>${item.description}</p>
        </div>
      </div>
    `).join("");
  } else {
    sitItems = (assetData.situationItems || []).map(item => `
      <div class="sit-card ${item.is_good_news ? 'good-news' : ''}">
        <div class="sit-icon">${item.icon_letter || 'S'}</div>
        <div class="sit-text">
          <h4>${item.title}</h4>
          <p>${item.description}</p>
        </div>
      </div>
    `).join("");
  }
  html = html.replace(/{{SITUATION_ITEMS}}/g, sitItems);

  let qaItems = "";
  if (templateName === "karthik.html") {
    qaItems = (assetData.questionsAnswered || []).map(item => `
      <div class="qa-row">
        <div class="qa-q">"${item.question}"</div>
        <div class="qa-a">${item.answer}</div>
      </div>
    `).join("");
  } else {
    qaItems = (assetData.questionsAnswered || []).map(item => `
      <div class="qa-card">
        <div class="qa-q">"${item.question}"</div>
        <div class="qa-a">${item.answer}</div>
      </div>
    `).join("");
  }
  html = html.replace(/{{QUESTIONS_ANSWERED}}/g, qaItems);

  html = html.replace(/{{PULL_QUOTE}}/g, assetData.pullQuote || "");

  let featItems = "";
  if (templateName === "karthik.html") {
    featItems = (assetData.whyScalerFeatures || []).map(item => `
      <div class="feat-row">
        <div class="feat-icon">${item.icon_letter || 'F'}</div>
        <div class="feat-text">
          <h4>${item.title}</h4>
          <p>${item.description}</p>
        </div>
      </div>
    `).join("");
  } else {
    featItems = (assetData.whyScalerFeatures || []).map(item => `
      <div class="feat-card">
        <h4>${item.title}</h4>
        <p>${item.description}</p>
      </div>
    `).join("");
  }
  html = html.replace(/{{WHY_SCALER_FEATURES}}/g, featItems);

  html = html.replace(/{{NEXT_STEP_TITLE}}/g, assetData.nextStepTitle || "");
  html = html.replace(/{{NEXT_STEP_BODY}}/g, assetData.nextStepBody || "");

  const pills = (assetData.whyTakeIt || []).map(item => `
    <div class="pill">${item}</div>
  `).join("");
  html = html.replace(/{{WHY_TAKE_IT_PILLS}}/g, pills);

  const isLocal = process.env.NODE_ENV === "development" || !process.env.VERCEL;
  
  let executablePath = null;
  if (isLocal) {
    try {
      executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      await fs.access(executablePath);
    } catch {
      executablePath = null;
    }
  }
  
  if (!executablePath) {
    // Download the pack at runtime on Vercel
    executablePath = await chromium.executablePath(
      "https://github.com/Sparticuz/chromium/releases/download/v122.0.0/chromium-v122.0.0-pack.tar"
    );
  }

  const browser = await puppeteer.launch({
    args: isLocal ? [] : chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: isLocal ? "new" : chromium.headless,
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });

  const pdfBuffer = await page.pdf({
    format: "A4",
    landscape: true,
    printBackground: true,
  });

  await browser.close();
  return Buffer.from(pdfBuffer);
}
