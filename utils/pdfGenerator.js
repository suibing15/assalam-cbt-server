// utils/pdfGenerator.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function applyWatermark(doc, logoPath) {
  if (fs.existsSync(logoPath)) {
    try {
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      doc.save();
      doc.opacity(0.07); // light subtle watermark
      const stepX = 150;
      const stepY = 150;
      for (let x = 50; x < pageWidth; x += stepX) {
        for (let y = 50; y < pageHeight; y += stepY) {
          doc.image(logoPath, x, y, { width: 40 });
        }
      }
      doc.restore();
      doc.opacity(1);
    } catch {}
  }
}

function generateExamPDF(meta, student, examMeta, outPath, callback) {
  try {
    ensureDir(path.dirname(outPath));
    const doc = new PDFDocument({ margin: 40, autoFirstPage: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const logoPath = path.join(__dirname, '../public/logo.png');
    const margin = 25;

    // --- Apply watermark & border on each page ---
    doc.on('pageAdded', () => {
      applyWatermark(doc, logoPath);
      doc.lineWidth(1).strokeColor('#999');
      doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).stroke();
    });

    // --- First page setup ---
    doc.fillColor('#000').opacity(1);
    doc.lineWidth(1).strokeColor('#999');
    doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).stroke();
    applyWatermark(doc, logoPath);

    // --- Logo ---
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, doc.page.width / 2 - 20, 45, { width: 40, height: 40 });
      } catch {}
    }

    // --- Title ---
    const title = meta.schoolName || 'School Name';
    doc.fontSize(15).font('Helvetica-Bold');
    const boxWidth = doc.widthOfString(title) + 60;
    const boxX = (doc.page.width - boxWidth) / 2;
    const boxY = 100;
    const boxHeight = 25;
    doc.rect(boxX, boxY, boxWidth, boxHeight).stroke();
    doc.text(title, 0, boxY + 6, { align: 'center' });

    // --- Info ---
    doc.fontSize(9).font('Helvetica').fillColor('#333');
    doc.text("Address: Behind Garko Motor pack opp. Tasidi filling station", 0, boxY + 33, { align: "center" });
    doc.text("Motto: Success comes after tears", 0, boxY + 46, { align: "center" });
    doc.text("Phone number: 08165789331, 08103992584, 08151015152", 0, boxY + 59, { align: "center" });
    doc.moveTo(60, boxY + 72).lineTo(540, boxY + 72).stroke();
    doc.y = boxY + boxHeight + 55;

    // --- Exam Info ---
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000');
    doc.text(`Exam: ${examMeta.type || ''} - ${examMeta.subject || ''}`, { align: 'center' });
    doc.text(`Session: {2025/2026}`, { align: 'center' });

    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');

    // --- Student Photo ---
    if (student.photoPath) {
      try {
        let photoFull;
        if (student.photoPath.startsWith('/uploads')) {
          photoFull = path.join(__dirname, '..', 'public', student.photoPath);
        } else if (student.photoPath.startsWith('uploads')) {
          photoFull = path.join(__dirname, '..', 'public', student.photoPath);
        } else {
          photoFull = path.join(__dirname, '..', student.photoPath);
        }

        if (fs.existsSync(photoFull)) {
          doc.image(photoFull, 430, doc.y - 5, { width: 90, height: 90 });
        }
      } catch {}
    }

    // --- Student details ---
    doc.text(`Name: ${student.name || ''}`, 60);
    doc.text(`Class: ${student.classId || ''}`, 60);
    doc.text(`Admission No: ${student.id || ''}`, 60);
    doc.text(`Submitted at: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`, 60);

    doc.moveDown(0.5);

    // --- Questions Section ---
    (examMeta.items || []).forEach((q, i) => {
      if (doc.y > doc.page.height - 120) doc.addPage();

      const hasImage = !!q.image;
      const imageWidth = hasImage ? 90 : 0; // Larger if image exists
      const imageHeight = hasImage ? 90 : 0;
      const textWidth = hasImage ? 330 : 450; // Adjust text area width if image beside it

      const questionY = doc.y;

      // --- Question text ---
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
      doc.text(`${i + 1}. ${q.text}`, 60, questionY, {
        width: textWidth,
        align: 'left',
      });

      // --- Question image (auto sized + neat spacing) ---
      if (hasImage) {
        try {
          let imgPath = q.image;
          if (imgPath.startsWith('/uploads')) {
            imgPath = path.join(__dirname, '..', 'public', imgPath);
          } else if (imgPath.startsWith('uploads')) {
            imgPath = path.join(__dirname, '..', 'public', imgPath);
          } else if (imgPath.startsWith('/public')) {
            imgPath = path.join(__dirname, '..', imgPath.replace(/^\//, ''));
          } else {
            imgPath = path.join(__dirname, '..', imgPath);
          }

          if (fs.existsSync(imgPath)) {
            const imageX = doc.page.width - 160;
            const imageY = questionY - 3;
            doc.image(imgPath, imageX, imageY, {
              width: imageWidth,
              height: imageHeight,
              align: 'right',
            });
          }
        } catch (e) {
          console.error('Error loading question image:', e.message);
        }
      }

      // --- Move below question block (smart spacing) ---
      const blockHeight = hasImage ? imageHeight + 10 : 25;
      doc.y = Math.max(doc.y, questionY + blockHeight);

      // --- Options and answers ---
      doc.font('Helvetica').fontSize(9).fillColor('#000');
      doc.text(`Options: ${(q.options || []).join(' | ')}`, 70);
      doc.text(`Correct answer: ${q.answer || ''}`, 70);
      doc.text(`Student answer: ${q.studentAnswer || ''}`, 70);

      doc.moveDown(hasImage ? 0.6 : 0.3);
    });

    // --- Score Summary ---
    const perc = examMeta.total ? ((examMeta.score / examMeta.total) * 100).toFixed(2) : 0;
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11)
      .text(`Score: ${examMeta.score || 0} / ${examMeta.total || 0} (${perc}%)`, 60);

    // --- Generated Info ---
    const generatedText = `Generated by ${meta.schoolName || 'School'} Portal - ${dayjs().format('YYYY-MM-DD')}`;
    doc.fontSize(8.5).fillColor('#444').text(generatedText, 60, doc.y + 10);

    doc.end();
    stream.on('finish', () => callback && callback(null, outPath));
    stream.on('error', (err) => callback && callback(err));
  } catch (err) {
    callback && callback(err);
  }
}

module.exports = { generateExamPDF };
