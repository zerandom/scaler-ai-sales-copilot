import fs from "fs/promises";
import path from "path";

export async function renderPdf(assetData, strategy, leadProfile) {
  const puppeteerMod = await import("puppeteer-core");
  const puppeteer = puppeteerMod.default || puppeteerMod;
  const sparticuz = await import("@sparticuz/chromium");
  const chromium = sparticuz.default || sparticuz;

  let templateName = "rohan.html";
  if (strategy.key === "senior-operator") templateName = "karthik.html";
  if (strategy.key === "career-risk") templateName = "meera.html";

  const templatePath = path.join(process.cwd(), "lib", "templates", templateName);
  let html = await fs.readFile(templatePath, "utf-8");

  html = html.replace(/{{PAGE1_HEADLINE}}/g, assetData.page1Headline || "");
  html = html.replace(/{{PAGE1_TAGLINE}}/g, assetData.page1Tagline || "");
  html = html.replace(/{{NAME}}/g, leadProfile.name || "Lead");
  html = html.replace(/{{ROLE}}/g, leadProfile.role ? `${leadProfile.role} · ${leadProfile.experience || ""} exp` : "");

  // Build situation items HTML
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

  // Build Q&A items HTML
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

  // Build Why Scaler features HTML
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

  // --- Browser Launch ---
  const isLocal = !process.env.VERCEL;

  let executablePath;
  if (isLocal) {
    // Try local Chrome on macOS
    const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      await fs.access(localChrome);
      executablePath = localChrome;
    } catch {
      // Fall through to chromium package
      executablePath = await chromium.executablePath();
    }
  } else {
    // On Vercel Lambda - chromium.executablePath() extracts the binary + libs into /tmp
    executablePath = await chromium.executablePath();
  }

  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 25000 });

    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
