import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function wrapText(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderPdf(assetData, strategy, leadProfile) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // A4 Landscape
  const W = 841;
  const H = 595;
  const M = 42;

  // Brand Palette (matching reference exactly)
  const navy    = rgb(14/255,  34/255,  64/255);
  const blue    = rgb(26/255,  80/255, 161/255);
  const orange  = rgb(255/255, 107/255,  34/255);
  const white   = rgb(1, 1, 1);
  const offWhite = rgb(248/255, 250/255, 253/255);
  const chipBg  = rgb(235/255, 244/255, 255/255);
  const goodGreen = rgb(52/255, 168/255, 83/255);
  const goodBg  = rgb(232/255, 248/255, 237/255);
  const gray    = rgb(100/255, 116/255, 139/255);
  const darkGray = rgb(60/255, 70/255, 85/255);

  // Helpers
  const r = (pg, x, y, w, h, col) =>
    pg.drawRectangle({ x, y, width: w, height: h, color: col });

  const circ = (pg, cx, cy, radius, col) =>
    pg.drawCircle({ x: cx, y: cy, size: radius, color: col });

  const iconBadge = (pg, cx, cy, radius, letter, bg, fg) => {
    circ(pg, cx, cy, radius, bg);
    const s = Math.max(radius * 0.65, 7);
    const tw = bold.widthOfTextAtSize(String(letter), s);
    pg.drawText(String(letter), { x: cx - tw / 2, y: cy - s * 0.38, size: s, font: bold, color: fg });
  };

  const safe = (pg, text, opts) => {
    try { pg.drawText(String(text || ""), opts); } catch (_) {}
  };

  const slideHeader = (pg, num, title, sub) => {
    const bsz = 34;
    r(pg, M, H - M - bsz, bsz, bsz, blue);
    const ntw = bold.widthOfTextAtSize(num, 13);
    safe(pg, num, { x: M + (bsz - ntw) / 2, y: H - M - bsz + 10, size: 13, font: bold, color: white });
    safe(pg, title, { x: M + bsz + 14, y: H - M - 23, size: 22, font: bold, color: navy });
    if (sub) safe(pg, sub, { x: M + bsz + 14, y: H - M - 41, size: 10, font, color: gray });
  };

  // ══════════════════════════════════════════════════════════════════
  // SLIDE 1: COVER
  // ══════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    const leftW = 310;
    r(pg, 0, 0, leftW, H, navy);
    r(pg, leftW, 0, W - leftW, H, offWhite);

    // Logo
    safe(pg, "SCALER", { x: M, y: H - M - 8, size: 17, font: bold, color: white });
    r(pg, M + 78, H - M - 8, 9, 13, orange);

    // Headline
    let hy = H - M - 68;
    for (const l of ["Your Personalized", "Career Plan"]) {
      safe(pg, l, { x: M, y: hy, size: 30, font: bold, color: white });
      hy -= 36;
    }

    // Subtitle
    for (const l of wrapText(assetData.subtitle || "Built for your goals. Backed by real outcomes.", font, 10, leftW - M * 2).slice(0, 2)) {
      safe(pg, l, { x: M, y: hy, size: 10, font, color: rgb(0.82, 0.82, 0.82) });
      hy -= 14;
    }

    // Prepared for
    hy -= 22;
    safe(pg, "Prepared for", { x: M, y: hy, size: 9, font, color: rgb(0.65, 0.65, 0.65) });
    hy -= 22;
    safe(pg, leadProfile.name || "Lead", { x: M, y: hy, size: 20, font: bold, color: white });
    hy -= 20;
    const roleExp = [leadProfile.role, leadProfile.experience].filter(Boolean).join("  •  ");
    safe(pg, roleExp, { x: M, y: hy, size: 10, font, color: rgb(0.78, 0.78, 0.78) });
    hy -= 14;
    if (leadProfile.company) {
      safe(pg, `@ ${leadProfile.company}`, { x: M, y: hy, size: 9, font, color: rgb(0.65, 0.65, 0.65) });
      hy -= 14;
    }
    hy -= 6;
    r(pg, M, hy - 26, leftW - M * 2, 30, rgb(0.07, 0.14, 0.24));
    safe(pg, "Based on your conversation", { x: M + 8, y: hy - 10, size: 8, font, color: rgb(0.7, 0.7, 0.7) });
    safe(pg, "with your Scaler BDA", { x: M + 8, y: hy - 22, size: 8, font, color: rgb(0.7, 0.7, 0.7) });

    // Bottom CTA card
    const bx = M, by = 38, bw = leftW - M * 2, bh = 70;
    r(pg, bx, by, bw, bh, white);
    r(pg, bx, by, 4, bh, orange);
    // Rocket circle
    circ(pg, bx + bw - 24, by + bh / 2, 14, chipBg);
    safe(pg, ">>", { x: bx + bw - 31, y: by + bh / 2 - 4, size: 9, font: bold, color: blue });
    safe(pg, "Next Step", { x: bx + 14, y: by + bh - 20, size: 11, font: bold, color: navy });
    safe(pg, "Take the assessment to unlock", { x: bx + 14, y: by + bh - 36, size: 8.5, font, color: gray });
    safe(pg, "the right path for you.", { x: bx + 14, y: by + bh - 48, size: 8.5, font, color: gray });

    // Mountain illustration (right panel)
    const mCX = leftW + (W - leftW) / 2 - 20;
    const mTop = H - 75;
    const mBase = 75;
    const mHW = 155; // half-width of mountain base
    pg.drawLine({ start: { x: mCX - mHW, y: mBase }, end: { x: mCX, y: mTop }, thickness: 2.5, color: blue });
    pg.drawLine({ start: { x: mCX + mHW, y: mBase }, end: { x: mCX, y: mTop }, thickness: 2.5, color: blue });
    // Path dots
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      circ(pg, mCX - mHW + mHW * t * 0.9, mBase + (mTop - mBase) * t, 5, orange);
    }
    // Flag
    pg.drawLine({ start: { x: mCX, y: mTop }, end: { x: mCX, y: mTop + 28 }, thickness: 2, color: blue });
    r(pg, mCX, mTop + 16, 22, 13, orange);

    safe(pg, "1", { x: leftW - 16, y: 14, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  }

  // ══════════════════════════════════════════════════════════════════
  // SLIDE 2: WHERE YOU STAND TODAY
  // ══════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "01", "Where You Stand Today", "A snapshot of your current situation");

    const items = (assetData.situationItems || []).slice(0, 5);
    const cardH = 74;
    const cardW = W - M * 2;
    let iy = H - 100;

    items.forEach((it) => {
      const isGood = it.is_good_news;
      r(pg, M, iy - cardH, cardW, cardH, isGood ? goodBg : offWhite);
      iconBadge(pg, M + 29, iy - cardH / 2, 16, it.icon_letter || "•", isGood ? goodGreen : blue, white);
      safe(pg, it.title || "", { x: M + 56, y: iy - 25, size: 12, font: bold, color: navy });
      let dy = iy - 40;
      for (const line of wrapText(it.description || "", font, 9, cardW - 72).slice(0, 2)) {
        safe(pg, line, { x: M + 56, y: dy, size: 9.5, font, color: gray });
        dy -= 13;
      }
      iy -= cardH + 10;
    });

    safe(pg, "2", { x: W - M, y: 14, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  }

  // ══════════════════════════════════════════════════════════════════
  // SLIDE 3: YOUR GOALS
  // ══════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "02", "Your Goals", "What you want to achieve next");

    const goals = (assetData.goals || []).slice(0, 3);
    const colW = (W - M * 2 - 32) / 3;
    const cardTop = H - 108;
    const cardH = 180;

    goals.forEach((g, i) => {
      const gx = M + i * (colW + 16);
      r(pg, gx, cardTop - cardH, colW, cardH, offWhite);
      iconBadge(pg, gx + colW / 2, cardTop - 26, 22, g.icon_letter || "G", blue, white);
      const tLines = wrapText(g.title || "", bold, 11, colW - 20).slice(0, 2);
      let ty = cardTop - 64;
      for (const l of tLines) {
        const tw = bold.widthOfTextAtSize(l, 11);
        safe(pg, l, { x: gx + (colW - tw) / 2, y: ty, size: 11, font: bold, color: navy });
        ty -= 15;
      }
      ty -= 4;
      for (const l of wrapText(g.description || "", font, 9, colW - 20).slice(0, 4)) {
        const tw = font.widthOfTextAtSize(l, 9);
        safe(pg, l, { x: gx + (colW - tw) / 2, y: ty, size: 9, font, color: gray });
        ty -= 13;
      }
    });

    // Target roles
    const pillLabelY = cardTop - cardH - 26;
    safe(pg, "Roles you are targeting", { x: M, y: pillLabelY, size: 10, font: bold, color: darkGray });
    let px = M;
    const pilsY = pillLabelY - 24;
    for (const role of (assetData.targetRoles || []).slice(0, 6)) {
      const rw = font.widthOfTextAtSize(role, 8.5) + 22;
      if (px + rw > W - M) break;
      r(pg, px, pilsY - 4, rw, 20, chipBg);
      safe(pg, role, { x: px + 11, y: pilsY + 4, size: 8.5, font, color: blue });
      px += rw + 8;
    }

    // Pull quote
    if (assetData.pullQuote) {
      r(pg, M, 48, W - M * 2, 40, chipBg);
      for (const l of wrapText(`"${assetData.pullQuote}"`, bold, 10, W - M * 2 - 30).slice(0, 2)) {
        safe(pg, l, { x: M + 16, y: 74, size: 10, font: bold, color: blue });
      }
    }

    safe(pg, "3", { x: W - M, y: 14, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  }

  // ══════════════════════════════════════════════════════════════════
  // SLIDE 4: KEY QUESTIONS ANSWERED
  // ══════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "03", "Your Key Questions, Answered", "Honest answers to what matters most to you");

    const qas = (assetData.questionsAnswered || []).slice(0, 3);
    const qCardH = 102;
    let qy = H - 102;

    qas.forEach((qa) => {
      r(pg, M, qy - qCardH, W - M * 2, qCardH, offWhite);
      iconBadge(pg, M + 25, qy - qCardH / 2, 17, qa.icon_letter || "?", blue, white);
      const qLines = wrapText(`"${qa.question}"`, bold, 10.5, W - M * 2 - 62).slice(0, 2);
      let qly = qy - 24;
      for (const l of qLines) {
        safe(pg, l, { x: M + 52, y: qly, size: 10.5, font: bold, color: navy });
        qly -= 15;
      }
      qly -= 3;
      for (const l of wrapText(qa.answer || "", font, 9.5, W - M * 2 - 62).slice(0, 3)) {
        safe(pg, l, { x: M + 52, y: qly, size: 9.5, font, color: gray });
        qly -= 13;
      }
      qy -= qCardH + 12;
    });

    // Bottom line band
    if (assetData.bottomLine) {
      r(pg, M, 36, W - M * 2, 44, navy);
      safe(pg, "Bottom line", { x: M + 16, y: 63, size: 10, font: bold, color: orange });
      for (const l of wrapText(assetData.bottomLine, font, 9.5, W - M * 2 - 105).slice(0, 2)) {
        safe(pg, l, { x: M + 103, y: 63, size: 9.5, font, color: white });
      }
    }

    safe(pg, "4", { x: W - M, y: 14, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  }

  // ══════════════════════════════════════════════════════════════════
  // SLIDE 5: WHY SCALER IS THE RIGHT FIT
  // ══════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "04", "Why Scaler is the Right Fit for You", "Designed for engineers. Built for outcomes.");

    const features = (assetData.whyScalerFeatures || []).slice(0, 6);
    // 3 cols × 2 rows
    const fW = (W - M * 2 - 32) / 3;
    const fH = 100;
    const fGap = 16;

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const col = i % 3;
      const row = Math.floor(i / 3);
      const fx = M + col * (fW + fGap);
      const fy = H - 108 - row * (fH + fGap);
      r(pg, fx, fy - fH, fW, fH, offWhite);
      iconBadge(pg, fx + 25, fy - 24, 17, f.icon_letter || "S", blue, white);
      safe(pg, f.title || "", { x: fx + 50, y: fy - 28, size: 11, font: bold, color: navy });
      let dy = fy - 44;
      for (const line of wrapText(f.description || "", font, 8.5, fW - 56).slice(0, 3)) {
        safe(pg, line, { x: fx + 50, y: dy, size: 8.5, font, color: gray });
        dy -= 12;
      }
    }

    // Stats bar
    r(pg, 0, 0, W, 56, navy);
    safe(pg, "1500+", { x: M, y: 34, size: 18, font: bold, color: white });
    safe(pg, "careers accelerated", { x: M, y: 18, size: 9, font, color: rgb(0.75, 0.85, 1) });
    safe(pg, "85%+", { x: W / 2, y: 34, size: 18, font: bold, color: white });
    safe(pg, "of learners make a career shift", { x: W / 2, y: 18, size: 9, font, color: rgb(0.75, 0.85, 1) });
    safe(pg, "*Based on internal data", { x: W - M - 130, y: 18, size: 7, font, color: rgb(0.55, 0.65, 0.75) });

    safe(pg, "5", { x: W - M, y: 68, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  }

  // ══════════════════════════════════════════════════════════════════
  // SLIDE 6: YOUR NEXT STEP
  // ══════════════════════════════════════════════════════════════════
  {
    const pg = pdfDoc.addPage([W, H]);
    r(pg, 0, 0, W, H, white);
    slideHeader(pg, "05", "Your Next Step", "A small step today for a big leap tomorrow.");

    const leftW = W * 0.55;

    // CTA card
    const cx2 = M, cy2 = 210, cw2 = leftW - M - 16, ch2 = 185;
    r(pg, cx2, cy2, cw2, ch2, chipBg);
    iconBadge(pg, cx2 + 28, cy2 + ch2 - 28, 19, "✓", blue, white);
    safe(pg, assetData.nextStepTitle || "Take the Assessment", { x: cx2 + 55, y: cy2 + ch2 - 22, size: 15, font: bold, color: navy });
    let bodyY = cy2 + ch2 - 48;
    for (const l of wrapText(assetData.nextStepBody || "", font, 9.5, cw2 - 28).slice(0, 4)) {
      safe(pg, l, { x: cx2 + 16, y: bodyY, size: 9.5, font, color: gray });
      bodyY -= 14;
    }
    // Pills row
    let px2 = cx2 + 16;
    const pr = cy2 + 20;
    for (const p of ["Personalized feedback", "Right batch recommendation", "Clarity on your readiness"]) {
      const pw = font.widthOfTextAtSize(p, 7.5) + 18;
      if (px2 + pw > cx2 + cw2 - 8) break;
      r(pg, px2, pr - 4, pw, 17, white);
      safe(pg, "✓ " + p, { x: px2 + 5, y: pr + 3, size: 7.5, font: bold, color: blue });
      px2 += pw + 6;
    }

    // Why take it checklist
    safe(pg, "Why take it?", { x: M, y: 190, size: 12, font: bold, color: navy });
    let ly = 167;
    for (const item of (assetData.whyTakeIt || []).slice(0, 4)) {
      circ(pg, M + 10, ly + 5, 7, goodBg);
      safe(pg, "✓", { x: M + 7, y: ly + 2, size: 7, font: bold, color: goodGreen });
      safe(pg, item, { x: M + 26, y: ly, size: 9.5, font, color: darkGray });
      ly -= 22;
    }

    // Staircase illustration
    const stX = leftW + 24;
    const stBase = 90;
    const stW = 68, stH = 50;
    for (let i = 0; i < 5; i++) {
      r(pg, stX + i * stW * 0.78, stBase + i * stH * 0.72, stW, stH, chipBg);
    }
    // Climber
    const clX = stX + 4 * stW * 0.78 + stW / 2;
    const clY = stBase + 4 * stH * 0.72 + stH + 20;
    circ(pg, clX, clY, 9, orange);
    pg.drawLine({ start: { x: clX, y: clY - 9 }, end: { x: clX, y: clY - 30 }, thickness: 3, color: orange });
    pg.drawLine({ start: { x: clX - 11, y: clY - 18 }, end: { x: clX + 11, y: clY - 18 }, thickness: 3, color: orange });

    // Footer
    r(pg, 0, 0, W, 44, navy);
    safe(pg, "We're excited to be part of your journey. Let's build the future, together.", { x: M, y: 16, size: 9, font, color: rgb(0.8, 0.88, 1) });
    safe(pg, "SCALER", { x: W - M - 68, y: 19, size: 13, font: bold, color: white });
    r(pg, W - M - 4, 20, 7, 11, orange);

    safe(pg, "6", { x: W - M, y: 55, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  }

  return await pdfDoc.save();
}
