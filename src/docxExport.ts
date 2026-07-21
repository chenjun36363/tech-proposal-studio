import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { Project } from "./types";

export function buildDocx(project: Project) {
  const children: Paragraph[] = [new Paragraph({ text: project.name, heading: HeadingLevel.TITLE })];
  for (const section of project.sections) {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1, pageBreakBefore: section.order > 0 }));
    for (const block of section.blocks) {
      for (const line of (block.content || " ").split("\n")) {
        children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: block.type === "code" ? "Consolas" : "Microsoft YaHei" })], style: block.type === "code" ? "Code" : undefined }));
      }
    }
  }
  return new Document({
    styles: {
      default: { document: { run: { font: "Microsoft YaHei", size: 21 }, paragraph: { spacing: { line: 360 } } } },
      paragraphStyles: [{ id: "Code", name: "Code", basedOn: "Normal", run: { font: "Consolas", size: 18 }, paragraph: { shading: { fill: "F3F5F3" }, spacing: { before: 80, after: 80 } } }]
    },
    sections: [{ properties: { page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } }, children }]
  });
}

export async function downloadDocx(project: Project) {
  const blob = await Packer.toBlob(buildDocx(project));
  const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = `${project.name}.docx`; anchor.click(); URL.revokeObjectURL(anchor.href);
}
