const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

/* ================= CONSTANTS ================= */
const BORDER_MARGIN = 25;
const INNER_MARGIN = BORDER_MARGIN + 15; // ✅ FIX: text stays inside border
const CONTENT_START_Y = 200;
const FOOTER_Y = 730;
const CONTENT_WIDTH = 595 - INNER_MARGIN * 2; // A4 safe width

async function generateQuestionPDF(meta, questions, outputPath) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  /* ========== HEADER FUNCTION ========== */
  function drawHeader() {
    // Border
    doc.lineWidth(1).strokeColor("#000");
    doc.rect(
      BORDER_MARGIN,
      BORDER_MARGIN,
      doc.page.width - BORDER_MARGIN * 2,
      doc.page.height - BORDER_MARGIN * 2
    ).stroke();

    // Logo
    const logoPath = path.join(__dirname, "../public/logo.png");
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, doc.page.width / 2 - 20, 40, { width: 40 });
      } catch {}
    }

    // School name box
    doc.font("Helvetica-Bold").fontSize(14);
    const name = meta.schoolName || "ASSALAM INTERNATIONAL ACADEMIC SCHOOL";
    const boxW = doc.widthOfString(name) + 60;
    const boxX = (doc.page.width - boxW) / 2;
    const boxY = 90;

    doc.rect(boxX, boxY, boxW, 26).stroke();
    doc.text(name, 0, boxY + 6, { align: "center" });

    // School info
    doc.font("Helvetica").fontSize(9);
    doc.text(
      "Address: Behind Garko Motor park opp. Tasidi filling station",
      INNER_MARGIN,
      boxY + 36,
      { width: CONTENT_WIDTH, align: "center" }
    );
    doc.text(
      "Motto: Success comes after tears",
      INNER_MARGIN,
      boxY + 50,
      { width: CONTENT_WIDTH, align: "center" }
    );
    doc.text(
      "Phone: 08165789331, 08103992584, 08151015152, 07068595598",
      INNER_MARGIN,
      boxY + 64,
      { width: CONTENT_WIDTH, align: "center" }
    );

    doc.moveTo(60, boxY + 80).lineTo(540, boxY + 80).stroke();
    doc.y = CONTENT_START_Y;
  }

  /* ========== INITIAL HEADER ========== */
  drawHeader();

  /* ========== HEADER ON EVERY PAGE ========== */
  doc.on("pageAdded", drawHeader);

  /* ========== META INFO ========== */
  doc.font("Helvetica-Bold").fontSize(10);
  doc.text(`Class: ${meta.className}`, INNER_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.text(`Subject: ${meta.subjectName}`, INNER_MARGIN, undefined, { width: CONTENT_WIDTH });
  doc.text(`Assessment Type: ${String(meta.type || "").toUpperCase()}`, INNER_MARGIN, undefined, { width: CONTENT_WIDTH });
  doc.text(`Term: ${meta.term || "_________"}`, INNER_MARGIN, undefined, { width: CONTENT_WIDTH });

  doc.moveDown(1);

  /* ========== QUESTIONS ========== */
  doc.font("Helvetica").fontSize(10);

  questions.forEach((q, idx) => {
    doc.text(
      `${idx + 1}. ${q.text}`,
      INNER_MARGIN,
      undefined,
      { width: CONTENT_WIDTH, align: "left" }
    );

    if (Array.isArray(q.options)) {
      doc.fontSize(9.5);
      q.options.forEach((opt, i) => {
        doc.text(
          `${String.fromCharCode(65 + i)}. ${opt}`,
          INNER_MARGIN + 15,
          undefined,
          { width: CONTENT_WIDTH - 15 }
        );
      });
      doc.fontSize(10);
    }

    doc.moveDown(0.4); // ✅ tighter spacing
  });

  doc.end();
  return new Promise(resolve => stream.on("finish", resolve));
}

module.exports = { generateQuestionPDF };
