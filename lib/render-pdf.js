import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

// --- Color palette matching HTML templates ---
const C = {
  greenDark: rgb(0.071, 0.208, 0.141),   // #123524
  greenLight: rgb(0.165, 0.353, 0.255),  // #2a5a41
  orange: rgb(0.918, 0.345, 0.047),      // #ea580c
  white: rgb(1, 1, 1),
  grayBg: rgb(0.973, 0.980, 0.988),      // #f8fafc
  grayText: rgb(0.278, 0.341, 0.412),    // #475569
  dark: rgb(0.102, 0.102, 0.102),        // #1a1a1a
};

// A4 landscape in points
const W = 841.89;
const H = 595.28;

// Simple word-wrap helper
function wrapText(text, maxChars) {
  const words = (text || "").split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars) {
      if (line) lines.push(line.trim());
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}

// Draw a filled rectangle
function rect(page, x, y, w, h, color) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

// Draw text with optional max width wrapping
function text(page, str, x, y, { font, size, color, maxChars, lineHeight }) {
  if (!str) return y;
  const lines = maxChars ? wrapText(str, maxChars) : [str];
  for (const line of lines) {
    page.drawText(line, { x, y, font, size, color });
    y -= lineHeight || size + 4;
  }
  return y;
}

export async function renderPdf(assetData, strategy, leadProfile) {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  // ── PAGE 1: COVER ──────────────────────────────────────────────────────────
  const p1 = doc.addPage([W, H]);

  // Left panel — dark green
  rect(p1, 0, 0, W * 0.5, H, C.greenDark);

  // Logo
  p1.drawText("SCALER", { x: 48, y: H - 52, font: bold, size: 18, color: C.white });

  // Orange headline
  const headline = assetData.page1Headline || "Your Transition Path";
  const headLines = wrapText(headline, 22);
  let hy = H - 110;
  for (const hl of headLines) {
    p1.drawText(hl, { x: 48, y: hy, font: bold, size: 38, color: C.orange });
    hy -= 46;
  }

  // Name + role
  p1.drawText(leadProfile.name || "Lead", { x: 48, y: hy - 20, font: bold, size: 22, color: C.white });
  const roleStr = leadProfile.role
    ? `${leadProfile.role}${leadProfile.experience ? "  ·  " + leadProfile.experience : ""}`
    : "";
  if (roleStr) p1.drawText(roleStr, { x: 48, y: hy - 46, font: regular, size: 13, color: C.white, opacity: 0.8 });

  // Tagline at bottom of left panel
  const tagLines = wrapText(assetData.page1Tagline || "Built for your goals.", 38);
  let ty = 70;
  // divider line
  p1.drawLine({ start: { x: 48, y: ty + tagLines.length * 18 + 12 }, end: { x: W * 0.5 - 48, y: ty + tagLines.length * 18 + 12 }, thickness: 1, color: C.white, opacity: 0.3 });
  for (const tl of [...tagLines].reverse()) {
    p1.drawText(tl, { x: 48, y: ty, font: regular, size: 12, color: C.white });
    ty += 18;
  }

  // Right panel — white with upward trend graphic
  rect(p1, W * 0.5, 0, W * 0.5, H, C.white);

  // Draw upward trend line (career growth graphic)
  const ox = W * 0.5 + 80;
  const oy = 80;
  const gw = W * 0.5 - 140;
  const gh = H - 140;
  // axis lines
  p1.drawLine({ start: { x: ox, y: oy }, end: { x: ox, y: oy + gh }, thickness: 3, color: C.greenDark });
  p1.drawLine({ start: { x: ox, y: oy }, end: { x: ox + gw, y: oy }, thickness: 3, color: C.greenDark });
  // trend line points
  const pts = [
    { x: ox, y: oy + gh * 0.1 },
    { x: ox + gw * 0.25, y: oy + gh * 0.35 },
    { x: ox + gw * 0.5, y: oy + gh * 0.55 },
    { x: ox + gw * 0.75, y: oy + gh * 0.78 },
    { x: ox + gw, y: oy + gh },
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    p1.drawLine({ start: pts[i], end: pts[i + 1], thickness: 3, color: C.greenLight });
    p1.drawCircle({ x: pts[i].x, y: pts[i].y, size: 5, color: C.orange });
  }
  // flag at top
  p1.drawCircle({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, size: 6, color: C.orange });
  p1.drawRectangle({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, width: 16, height: 10, color: C.orange });

  // Next Step box bottom-right
  const nsX = W * 0.5 + 48;
  const nsY = 28;
  rect(p1, nsX, nsY, W * 0.5 - 80, 44, C.white);
  p1.drawRectangle({ x: nsX, y: nsY, width: W * 0.5 - 80, height: 44, borderColor: C.grayBg, borderWidth: 1.5 });
  p1.drawText(assetData.nextStepTitle || "Next Step", { x: nsX + 12, y: nsY + 26, font: bold, size: 11, color: C.greenDark });
  const nsBodyLines = wrapText(assetData.nextStepBody || "Take the assessment.", 55);
  p1.drawText(nsBodyLines[0] || "", { x: nsX + 12, y: nsY + 11, font: regular, size: 9, color: C.grayText });

  p1.drawText("1", { x: W - 28, y: 16, font: regular, size: 10, color: C.grayText });

  // ── PAGE 2: SITUATION + Q&A ────────────────────────────────────────────────
  const p2 = doc.addPage([W, H]);
  rect(p2, 0, 0, W, H, C.grayBg);

  // Section headers
  p2.drawText("Where You Stand", { x: 40, y: H - 48, font: bold, size: 20, color: C.greenDark });
  p2.drawText("Questions Answered", { x: W / 2 + 20, y: H - 48, font: bold, size: 20, color: C.orange });

  // Situation items (left column)
  const sitItems = (assetData.situationItems || []).slice(0, 4);
  let sy = H - 78;
  const cardH = (H - 130) / Math.max(sitItems.length, 1) - 8;
  for (const item of sitItems) {
    const isGood = item.is_good_news;
    const bgColor = isGood ? C.greenDark : C.white;
    const textColor = isGood ? C.white : C.dark;
    const subColor = isGood ? rgb(0.8, 0.8, 0.8) : C.grayText;
    rect(p2, 40, sy - cardH, W / 2 - 60, cardH, bgColor);
    // Left accent bar
    p2.drawRectangle({ x: 40, y: sy - cardH, width: 4, height: cardH, color: isGood ? C.orange : C.greenLight });
    // Icon circle
    rect(p2, 52, sy - cardH + cardH / 2 - 12, 24, 24, isGood ? rgb(1, 1, 1, 0.1) : C.grayBg);
    p2.drawText(item.icon_letter || "S", { x: 58, y: sy - cardH + cardH / 2 - 5, font: bold, size: 11, color: isGood ? C.orange : C.greenDark });
    // Title + description
    const titleLines = wrapText(item.title || "", 38);
    let tty = sy - 14;
    for (const tl of titleLines) {
      p2.drawText(tl, { x: 84, y: tty, font: bold, size: 11, color: textColor });
      tty -= 14;
    }
    const descLines = wrapText(item.description || "", 42);
    for (const dl of descLines.slice(0, 2)) {
      p2.drawText(dl, { x: 84, y: tty, font: regular, size: 9, color: subColor });
      tty -= 12;
    }
    sy -= cardH + 8;
  }

  // Q&A items (right column)
  const qaItems = (assetData.questionsAnswered || []).slice(0, 3);
  const qaH = (H - 130) / Math.max(qaItems.length, 1) - 8;
  let qy = H - 78;
  for (const item of qaItems) {
    rect(p2, W / 2 + 20, qy - qaH, W / 2 - 60, qaH, C.white);
    p2.drawRectangle({ x: W / 2 + 20, y: qy - 4, width: W / 2 - 60, height: 4, color: C.orange });
    const qLines = wrapText(`"${item.question || ""}"`, 45);
    let qvy = qy - 20;
    for (const ql of qLines.slice(0, 2)) {
      p2.drawText(ql, { x: W / 2 + 32, y: qvy, font: bold, size: 11, color: C.greenDark });
      qvy -= 14;
    }
    const aLines = wrapText(item.answer || "", 50);
    for (const al of aLines.slice(0, 3)) {
      p2.drawText(al, { x: W / 2 + 32, y: qvy, font: regular, size: 9, color: C.grayText });
      qvy -= 12;
    }
    qy -= qaH + 8;
  }

  // Pull quote bar
  rect(p2, 40, 12, W - 80, 36, C.greenDark);
  const pqLines = wrapText(`"${assetData.pullQuote || ""}"`, 90);
  p2.drawText(pqLines[0] || "", { x: 56, y: 25, font: bold, size: 11, color: C.white, opacity: 0.9 });
  p2.drawText("2", { x: W - 28, y: 16, font: regular, size: 10, color: C.grayText });

  // ── PAGE 3: WHY SCALER + CTA ───────────────────────────────────────────────
  const p3 = doc.addPage([W, H]);
  rect(p3, 0, 0, W, H, C.white);

  p3.drawText("Why This Makes Sense", { x: W / 2 - 120, y: H - 48, font: bold, size: 22, color: C.greenDark });

  // Feature cards 2x2 grid
  const feats = (assetData.whyScalerFeatures || []).slice(0, 4);
  const fW = (W - 80) / 2 - 10;
  const fH = 90;
  const gridTop = H - 72;
  for (let i = 0; i < feats.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const fx = 40 + col * (fW + 20);
    const fy = gridTop - row * (fH + 10) - fH;
    rect(p3, fx, fy, fW, fH, C.grayBg);
    p3.drawRectangle({ x: fx, y: fy, width: 4, height: fH, color: C.greenLight });
    const ftLines = wrapText(feats[i].title || "", 32);
    let fty = fy + fH - 20;
    for (const fl of ftLines.slice(0, 1)) {
      p3.drawText(fl, { x: fx + 14, y: fty, font: bold, size: 13, color: C.greenDark });
      fty -= 16;
    }
    const fdLines = wrapText(feats[i].description || "", 40);
    for (const fd of fdLines.slice(0, 3)) {
      p3.drawText(fd, { x: fx + 14, y: fty, font: regular, size: 9.5, color: C.grayText });
      fty -= 12;
    }
  }

  // CTA section
  const ctaY = 16;
  const ctaH = 120;
  rect(p3, 40, ctaY, W - 80, ctaH, C.greenDark);

  const ctaTitleLines = wrapText(assetData.nextStepTitle || "Next Step", 28);
  let ctaTY = ctaY + ctaH - 28;
  for (const cl of ctaTitleLines) {
    p3.drawText(cl, { x: 60, y: ctaTY, font: bold, size: 20, color: C.orange });
    ctaTY -= 24;
  }
  const ctaBodyLines = wrapText(assetData.nextStepBody || "", 55);
  for (const bl of ctaBodyLines.slice(0, 2)) {
    p3.drawText(bl, { x: 60, y: ctaTY, font: regular, size: 11, color: C.white });
    ctaTY -= 14;
  }
  // Pills
  let pillX = 60;
  for (const pill of (assetData.whyTakeIt || []).slice(0, 3)) {
    const pw = Math.min(pill.length * 7 + 20, 200);
    rect(p3, pillX, ctaY + 14, pw, 22, rgb(1, 1, 1, 0.1));
    p3.drawText(pill, { x: pillX + 10, y: ctaY + 20, font: regular, size: 9, color: C.white });
    pillX += pw + 10;
  }

  p3.drawText("3", { x: W - 28, y: 16, font: regular, size: 10, color: C.grayText });

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
