"use strict";

const fs = require("fs");
const path = require("path");

const checkpoint = path.join(process.cwd(), "scrape-checkpoint.json");
const badName = "head of finance, accounting, and tax";
const expected = [
  "muhammad adam prayoga",
  "i kadek teken",
  "elizabeth desnita",
  "reiner lesmana",
  "suwandi simon"
];

const normalize = x =>
  typeof x === "string" ? x.trim().toLowerCase() : "";

const getNames = x => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return [];
  return [
    x.name, x.fullName, x.candidateName,
    x.displayName, x.candidate?.name
  ].map(normalize).filter(Boolean);
};

if (!fs.existsSync(checkpoint)) {
  throw Error("STOP: scrape-checkpoint.json not found");
}

const doc = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
const foundNames = new Set();
const bad = [];

function walk(node) {
  if (Array.isArray(node)) {
    node.forEach((row, index) => {
      const names = getNames(row);
      names.forEach(n => foundNames.add(n));

      if (names.includes(badName)) {
        bad.push({array: node, index, row});
      }

      walk(row);
    });
  } else if (node && typeof node === "object") {
    Object.values(node).forEach(walk);
  }
}

walk(doc);

if (process.env.CHECK_FIVE === "1") {
  const missing = expected.filter(n => !foundNames.has(n));

  if (missing.length) {
    throw Error("STOP: Candidate missing from checkpoint: " + missing.join(", "));
  }

  console.log("VERIFIED: All 5 recent candidates in checkpoint");
}

if (bad.length > 1) {
  throw Error("STOP: Multiple ambiguous records; no changes");
}

if (bad.length === 0) {
  console.log("No malformed record found; checkpoint unchanged");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:.]/g, "");
const backup = checkpoint + ".backup-" + stamp;
const quarantine = checkpoint + ".quarantined-" + stamp + ".json";
const temp = checkpoint + ".tmp-" + process.pid;

fs.copyFileSync(checkpoint, backup);

fs.writeFileSync(
  quarantine,
  JSON.stringify({
    reason: "Position unresolved - manual review required",
    record: bad[0].row
  }, null, 2)
);

bad[0].array.splice(bad[0].index, 1);

fs.writeFileSync(temp, JSON.stringify(doc, null, 2));
fs.renameSync(temp, checkpoint);

console.log("SUCCESS: 1 problematic candidate quarantined");
console.log("Other candidate records preserved");
console.log("Backup:", backup);
console.log("Quarantine:", quarantine);
