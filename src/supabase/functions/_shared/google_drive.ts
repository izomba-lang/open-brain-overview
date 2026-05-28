// Google Drive upload helper — OAuth2 refresh token + Drive API v3

export async function getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!res.ok) throw new Error(`GDrive token refresh failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

export async function uploadFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  mimeType: string,
  fileData: ArrayBuffer,
): Promise<{ id: string; webViewLink: string }> {
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const boundary = "----ob" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();

  const metaPart = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
  );
  const filePart = enc.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const closePart = enc.encode(`\r\n--${boundary}--`);
  const fileBytes = new Uint8Array(fileData);

  const body = new Uint8Array(metaPart.length + filePart.length + fileBytes.length + closePart.length);
  let off = 0;
  body.set(metaPart, off); off += metaPart.length;
  body.set(filePart, off); off += filePart.length;
  body.set(fileBytes, off); off += fileBytes.length;
  body.set(closePart, off);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`GDrive upload failed: ${await res.text()}`);
  return await res.json();
}
