// Node 18+
// Usage: node scripts/upload.js --url <URL> --filename <NAME> --refreshTokenName <SECRET_KEY> --parentKey <PARENT_SECRET_KEY>

import { fetch } from "undici";
import fs from "node:fs";

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg("url");
let filename = arg("filename");
const refreshTokenName = arg("refreshTokenName");
const parentKey = arg("parentKey");

if (!url || !refreshTokenName) {
  console.error("Missing required args: --url and --refreshTokenName");
  process.exit(1);
}

if (!filename) {
  try {
    const p = new URL(url).pathname;
    filename = decodeURIComponent(p.split("/").filter(Boolean).pop() || "remote-file");
  } catch {
    filename = "remote-file";
  }
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env[refreshTokenName]; // e.g., DRIVE_REFRESH_TOKEN_MAIN
const PARENT_FOLDER = parentKey ? process.env[parentKey] : undefined;

console.log("DEBUG: Script received:");
console.log(`  refreshTokenName arg: ${refreshTokenName}`);
console.log(`  GOOGLE_CLIENT_ID length: ${GOOGLE_CLIENT_ID?.length || 0}`);
console.log(`  GOOGLE_CLIENT_SECRET length: ${GOOGLE_CLIENT_SECRET?.length || 0}`);
console.log(`  REFRESH_TOKEN (from env[${refreshTokenName}]) length: ${REFRESH_TOKEN?.length || 0}`);
console.log("DEBUG: All DRIVE_ env vars:");
Object.keys(process.env).filter(k => k.startsWith('DRIVE_')).forEach(k => {
  console.log(`  ${k}: length ${process.env[k]?.length || 0}`);
});

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Missing Google OAuth secrets or refresh token env.");
  console.error(`  GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID ? 'EXISTS' : 'MISSING'}`);
  console.error(`  GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET ? 'EXISTS' : 'MISSING'}`);
  console.error(`  REFRESH_TOKEN: ${REFRESH_TOKEN ? 'EXISTS' : 'MISSING'}`);
  process.exit(1);
}

async function getAccessToken() {
  console.log("Exchanging refresh token for access token...");
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  console.log("Access token obtained");
  return j.access_token;
}

async function startResumable(accessToken, { name, parents }) {
  console.log(`Starting resumable upload session for: ${name}`);
  const meta = { name };
  if (parents && parents.length) {
    meta.parents = parents;
    console.log(`Target folder: ${parents[0]}`);
  }
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/octet-stream"
    },
    body: JSON.stringify(meta)
  });
  if (!r.ok) throw new Error(`Start session failed: ${r.status} ${await r.text()}`);
  const loc = r.headers.get("Location");
  if (!loc) throw new Error("No resumable session URL");
  console.log("Resumable session created");
  return loc;
}

async function pipeUrlToDriveSession(remoteUrl, sessionUrl) {
  console.log(`Fetching remote file: ${remoteUrl}`);
  const src = await fetch(remoteUrl, { redirect: "follow" });
  if (!src.ok || !src.body) throw new Error(`Fetch source failed: ${src.status} ${await src.text()}`);

  const contentLength = src.headers.get("content-length");
  if (contentLength) {
    console.log(`File size: ${(parseInt(contentLength) / 1024 / 1024).toFixed(2)} MB`);
  }

  console.log("Streaming to Google Drive...");
  const put = await fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: src.body,
    duplex: "half"
  });

  if (!put.ok) {
    const msg = await put.text();
    throw new Error(`Upload failed: ${put.status} ${msg}`);
  }
  console.log("Upload complete!");
  return await put.json(); // Drive file resource
}

async function main() {
  console.log("=== Google Drive Remote Uploader ===");
  console.log(`URL: ${url}`);
  console.log(`Filename: ${filename}`);
  console.log(`Refresh Token: ${refreshTokenName}`);
  if (parentKey) console.log(`Parent Folder: ${parentKey}`);
  console.log("");

  const accessToken = await getAccessToken();
  const sessionUrl = await startResumable(accessToken, {
    name: filename,
    parents: PARENT_FOLDER ? [PARENT_FOLDER] : undefined
  });
  const created = await pipeUrlToDriveSession(url, sessionUrl);

  // Save result artifact
  const result = {
    fileId: created.id,
    name: created.name || filename,
    mimeType: created.mimeType,
    size: created.size,
    webViewLink: created.webViewLink || `https://drive.google.com/file/d/${created.id}/view`
  };

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/result.json", JSON.stringify(result, null, 2));

  console.log("");
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`✓ File uploaded successfully: ${result.webViewLink}`);
}

main().catch(err => {
  console.error("");
  console.error("=== ERROR ===");
  console.error(err.message);
  console.error(err.stack);
  process.exit(1);
});
