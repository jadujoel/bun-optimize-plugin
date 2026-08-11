import tgz from "./assets/sample.tgz";
import zip from "./assets/sample.zip";

const downloads: Array<[string, string]> = [
  ["zip", zip],
  ["tgz", tgz],
];

const section = document.getElementById("downloads");
for (const [label, url] of downloads) {
  const figure = document.createElement("figure");
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.textContent = url.split("/").pop() ?? url;
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  figure.append(link, caption);
  section?.append(figure);
}
