import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DEFAULT_PREFIX = "computehive/run-requests/";
const COMPRESSED_IMAGE_KEY =
  /^computehive\/run-requests\/.+\/[^/]+-[0-9a-f]{16,64}\.tar\.gz$/i;

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const output = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

function requiredConfig(key, envValues) {
  const value = process.env[key] || envValues[key];
  if (!value) {
    throw new Error(`Missing required configuration value: ${key}`);
  }
  return value;
}

function parseBucketUrl(bucketUrl) {
  const url = new URL(bucketUrl);
  const bucketName = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!bucketName) {
    throw new Error("S3_BUCKET must include the bucket name in the path.");
  }
  return {
    bucketName,
    endpoint: `${url.protocol}//${url.host}`,
  };
}

function hex(buffer) {
  return Buffer.from(buffer).toString("hex");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function awsNow() {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodePath(pathname) {
  return pathname
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }
      return leftKey.localeCompare(rightKey);
    })
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

function signedHeaders(headers) {
  return Object.keys(headers)
    .map((key) => key.toLowerCase())
    .sort()
    .join(";");
}

function canonicalHeaders(headers) {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
}

function signRequest({
  method,
  url,
  accessKeyId,
  secretAccessKey,
  region,
  payloadHash,
  extraHeaders = {},
}) {
  const { amzDate, dateStamp } = awsNow();
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };

  const canonicalRequest = [
    method,
    encodePath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders(headers),
    signedHeaders(headers),
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp),
        region,
      ),
      "s3",
    ),
    "aws4_request",
  );

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders(headers)}`,
    `Signature=${hex(hmac(signingKey, stringToSign))}`,
  ].join(", ");

  return {
    headers: {
      ...headers,
      authorization,
    },
  };
}

async function signedFetch({
  method,
  url,
  accessKeyId,
  secretAccessKey,
  region,
  payloadHash = EMPTY_SHA256,
  body,
  extraHeaders,
}) {
  const { headers } = signRequest({
    method,
    url,
    accessKeyId,
    secretAccessKey,
    region,
    payloadHash,
    extraHeaders,
  });

  return fetch(url, {
    method,
    headers,
    body,
  });
}

async function listObjects(config, prefix) {
  const keys = [];
  let continuationToken = "";

  while (true) {
    const url = new URL(`${config.endpoint}/${config.bucketName}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) {
      url.searchParams.set("continuation-token", continuationToken);
    }

    const response = await signedFetch({
      method: "GET",
      url,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`ListObjectsV2 failed with status ${response.status}: ${body}`);
    }

    const matches = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)];
    keys.push(...matches.map((match) => match[1]));

    const tokenMatch = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!tokenMatch) {
      break;
    }

    continuationToken = tokenMatch[1];
  }

  return keys;
}

async function deleteObject(config, key) {
  const url = new URL(`${config.endpoint}/${config.bucketName}/${key}`);
  const response = await signedFetch({
    method: "DELETE",
    url,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  });

  const body = await response.text();
  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete failed for ${key} with status ${response.status}: ${body}`);
  }
}

async function main() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const clientDir = path.resolve(scriptDir, "..");
  const envValues = parseEnvFile(path.join(clientDir, ".env"));
  const bucketUrl = requiredConfig("S3_BUCKET", envValues);
  const accessKeyId = requiredConfig("S3_ACCESS_KEY_ID", envValues);
  const secretAccessKey = requiredConfig("S3_SECRET_ACCESS_KEY", envValues);
  const region = process.env.S3_REGION || "auto";
  const execute = process.argv.includes("--execute");
  const prefixArg = process.argv.find((arg) => arg.startsWith("--prefix="));
  const prefix = prefixArg ? prefixArg.slice("--prefix=".length) : DEFAULT_PREFIX;

  const { endpoint, bucketName } = parseBucketUrl(bucketUrl);
  const config = {
    endpoint,
    bucketName,
    accessKeyId,
    secretAccessKey,
    region,
  };

  const allKeys = await listObjects(config, prefix);
  const matchedKeys = allKeys.filter((key) => COMPRESSED_IMAGE_KEY.test(key));

  const logDirectory = path.join(clientDir, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(
    logDirectory,
    `r2-compressed-image-deletion-${timestamp}.json`,
  );

  const result = {
    bucketName,
    endpoint,
    prefix,
    matchedCount: matchedKeys.length,
    deletedCount: 0,
    deletedKeys: [],
    dryRun: !execute,
    createdAt: new Date().toISOString(),
  };

  if (execute) {
    for (const key of matchedKeys) {
      await deleteObject(config, key);
      result.deletedKeys.push(key);
    }
    result.deletedCount = result.deletedKeys.length;
  }

  fs.writeFileSync(logPath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({ ...result, logPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
