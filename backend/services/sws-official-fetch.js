// Node worker only. The SWS server omits its intermediate certificate. Supply
// the public DigiCert-signed intermediate without disabling TLS verification.
import https from "node:https";
import { rootCertificates } from "node:tls";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
let agent;
function verifiedAgent() {
  if (agent) return agent;
  const pem = readFileSync(
      new URL("./sws-intermediate-ca.pem", import.meta.url),
      "utf8",
    ),
    certificate = new X509Certificate(pem);
  if (
    !rootCertificates.some((pem) => {
      const root = new X509Certificate(pem);
      return (
        certificate.checkIssued(root) && certificate.verify(root.publicKey)
      );
    })
  )
    throw new Error("申万官网中间证书无法通过受信任根证书验证");
  agent = new https.Agent({ ca: [...rootCertificates, pem], keepAlive: true });
  return agent;
}
export function swsOfficialFetch(url, { headers, signal } = {}) {
  if (new URL(url).origin !== "https://www.swsresearch.com")
    throw new Error("申万官方请求地址无效");
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { agent: verifiedAgent(), headers, signal },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("error", reject);
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > 10000000)
            return request.destroy(new Error("申万官方分类文件超过大小上限"));
          chunks.push(chunk);
        });
        response.on("end", () => {
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              resultHeaders.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: resultHeaders,
            }),
          );
        });
      },
    );
    request.on("error", reject);
  });
}
