const fs = require("fs");
const path = require("path");

const dataPath = path.join(__dirname, "../data/data.json");

function readData() {
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

function writeData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

function getLicense() {
  const data = readData();
  return data.license || {};
}

function updateLicense(update) {
  const data = readData();
  data.license = { ...(data.license || {}), ...update };
  writeData(data);
}

module.exports = { getLicense, updateLicense };
