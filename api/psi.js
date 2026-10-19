// Haze Watch feed: turns NEA's official PSI and PM2.5 readings (data.gov.sg) into an RSS feed
// that Zapier's free "RSS by Zapier" trigger can watch. One item per scheduled reading.
// Version 2 (fix after the tricky case): when NEA has no reading for a slot, the feed publishes a
// "reading not available" item, so I get an email instead of silence.
// Version 3: a clearer email (colour-coded bands, one row per region). The styled HTML is also
// sent as <content:encoded>, because Zapier's plain "Description" field strips HTML tags.

const SLOTS = [8, 11, 14, 17, 20];           // Singapore hours that get an email (5 a day)
const READY_AFTER_MIN = 20;                    // NEA publishes about 15 minutes after the hour
const API = "https://api-open.data.gov.sg/v2/real-time/api/";
const REGIONS = ["north", "south", "east", "west", "central"];

// NEA bands (NEA advisory "How to plan your outdoor activities during haze", July 2024)
function psiBand(v) {
  if (v <= 50) return ["Good", "Normal activities"];
  if (v <= 100) return ["Moderate", "Normal activities"];
  if (v <= 200) return ["Unhealthy", "Normal activities for healthy persons"];
  if (v <= 300) return ["Very unhealthy", "Minimise outdoor activity"];
  return ["Hazardous", "Avoid outdoor activity"];
}
function pm25Band(v) {
  if (v <= 55) return ["Band I, Normal", "Continue with normal activities"];
  if (v <= 150) return ["Band II, Elevated", "Reduce strenuous outdoor activity for the next hour"];
  if (v <= 250) return ["Band III, High", "Avoid strenuous outdoor activity for the next hour"];
  return ["Band IV, Very high", "Minimise all outdoor activity for the next hour"];
}

const pad = n => String(n).padStart(2, "0");
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Latest slot whose reading should be out, as "YYYY-MM-DDTHH:00:00" in Singapore time
function latestSlot(now = new Date()) {
  const sg = new Date(now.getTime() + 8 * 3600e3);        // shift to SGT, read with getUTC*
  for (let back = 0; back < 2; back++) {
    const day = new Date(sg.getTime() - back * 86400e3);
    for (const h of [...SLOTS].reverse()) {
      const slotSg = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, READY_AFTER_MIN);
      if (slotSg <= sg.getTime()) {
        return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${pad(h)}:00:00`;
      }
    }
  }
}

async function reading(kind, at) {
  const r = await fetch(`${API}${kind}?date=${encodeURIComponent(at)}`, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  const item = j?.data?.items?.find(i => i.timestamp?.startsWith(at)) || null;
  return item;
}

function slotLabel(at) {
  const hour = Number(at.slice(11, 13));
  return `${Number(at.slice(8, 10))} ${new Date(at + "Z").toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

function missingItem(at, psi, pm) {
  const when = slotLabel(at);
  const gone = [!psi && "24-hr PSI", !pm && "1-hr PM2.5"].filter(Boolean).join(" and ");
  const title = `Haze Watch ${when}: NEA reading NOT available, check haze.gov.sg before going out`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2328;max-width:560px;font-size:14px;line-height:1.45;padding:12px 14px;border-left:6px solid #cf222e;background:#fff1f0;border-radius:6px">` +
    `<p style="margin:0 0 8px;font-size:16px"><b>No reading for ${when} (Singapore time).</b></p>` +
    `<p>NEA's ${gone} for this hour ${psi || pm ? "was" : "were"} not available on data.gov.sg when Haze Watch checked. ` +
    `This does not mean the air is fine. Please check <a href="https://www.haze.gov.sg/">haze.gov.sg</a> yourself before going out.</p>` +
    `<p style="margin:0">Haze Watch will send the next reading at the next scheduled time.</p></div>`;
  return { title, html, guid: `haze-watch-missing-${at}`, pubDate: new Date().toUTCString() };
}

// Colours for the email: green for normal, amber for moderate or elevated, red for unhealthy or high and above
const PSI_COLOUR = { "Good": "#1a7f37", "Moderate": "#9a6700", "Unhealthy": "#cf222e", "Very unhealthy": "#a40e26", "Hazardous": "#6e1a8c" };
const PM_COLOUR = { "Band I, Normal": "#1a7f37", "Band II, Elevated": "#9a6700", "Band III, High": "#cf222e", "Band IV, Very high": "#a40e26" };
const cap = r => r[0].toUpperCase() + r.slice(1);
const badge = (text, colour) =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${colour};color:#ffffff;font-size:12px;font-weight:bold;white-space:nowrap">${esc(text)}</span>`;

function buildItem(at, psi, pm) {
  const p24 = psi.readings.psi_twenty_four_hourly;
  const p1 = pm.readings.pm25_one_hourly;
  const worstPsi = Math.max(...REGIONS.map(r => p24[r]));
  const worstPm = Math.max(...REGIONS.map(r => p1[r]));
  const [psiName, psiAdvice] = psiBand(worstPsi);
  const [pmName, pmAdvice] = pm25Band(worstPm);
  const when = slotLabel(at);
  const worstRegions = REGIONS.filter(r => p24[r] === worstPsi).map(cap).join(", ");
  const worstPmRegions = REGIONS.filter(r => p1[r] === worstPm).map(cap).join(", ");

  const title = `Haze Watch ${when}: PSI up to ${worstPsi} (${psiName}, ${worstRegions}) · PM2.5 now up to ${worstPm} (${pmName})`;

  const font = "font-family:Arial,Helvetica,sans-serif;color:#1f2328";
  const summary = (label, value, unit, band, colour, where, advice) =>
    `<div style="margin:0 0 12px;padding:12px 14px;border-left:6px solid ${colour};background:#f6f8fa;border-radius:6px">` +
      `<div style="font-size:12px;color:#57606a;text-transform:uppercase;letter-spacing:.5px">${label}</div>` +
      `<div style="font-size:26px;font-weight:bold;color:${colour};margin:2px 0">${value}<span style="font-size:13px;color:#57606a;font-weight:normal"> ${unit}</span> ${badge(band, colour)}</div>` +
      `<div style="font-size:14px">Worst: ${esc(where)}. <b>NEA advice:</b> ${esc(advice)}.</div>` +
    `</div>`;

  const regionRows = REGIONS.map(r => {
    const [pb] = psiBand(p24[r]);
    const [mb] = pm25Band(p1[r]);
    const hot = PSI_COLOUR[pb] === "#cf222e" || PSI_COLOUR[pb] === "#a40e26" || PSI_COLOUR[pb] === "#6e1a8c";
    return `<tr style="background:${hot ? "#fff1f0" : "#ffffff"}">` +
      `<td style="padding:10px 12px;border-bottom:1px solid #d0d7de;font-weight:bold">${cap(r)}</td>` +
      `<td style="padding:10px 12px;border-bottom:1px solid #d0d7de"><span style="font-size:18px;font-weight:bold;color:${PSI_COLOUR[pb]}">${p24[r]}</span><br>${badge(pb, PSI_COLOUR[pb])}</td>` +
      `<td style="padding:10px 12px;border-bottom:1px solid #d0d7de"><span style="font-size:18px;font-weight:bold;color:${PM_COLOUR[mb]}">${p1[r]}</span><br>${badge(mb, PM_COLOUR[mb])}</td>` +
    `</tr>`;
  }).join("");

  const html =
    `<div style="${font};max-width:560px;font-size:14px;line-height:1.45">` +
      `<div style="font-size:18px;font-weight:bold;margin:0 0 12px">Haze Watch · ${when} (Singapore time)</div>` +
      summary("Now: 1-hr PM2.5", worstPm, "µg/m³", pmName, PM_COLOUR[pmName], worstPmRegions, pmAdvice) +
      summary("Today: 24-hr PSI", worstPsi, "", psiName, PSI_COLOUR[psiName], worstRegions, psiAdvice + " (vulnerable persons: see haze.gov.sg)") +
      `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid #d0d7de;border-radius:6px;margin:4px 0 14px">` +
        `<tr style="background:#f6f8fa"><th align="left" style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a">REGION</th>` +
        `<th align="left" style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a">24-HR PSI</th>` +
        `<th align="left" style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a">1-HR PM2.5</th></tr>` +
        regionRows +
      `</table>` +
      `<div style="font-size:12px;color:#57606a">Rows shaded red are Unhealthy or worse. Elderly, children, pregnant women and people with heart or lung conditions should follow NEA's advice for vulnerable persons at <a href="https://www.haze.gov.sg/">haze.gov.sg</a>. This email repeats NEA's published bands only and is not medical advice.<br>` +
      `Source: NEA via data.gov.sg (PSI timestamp ${esc(psi.timestamp)}, updated ${esc(psi.updatedTimestamp)}).</div>` +
    `</div>`;

  return { title, html, guid: `haze-watch-${at}`, pubDate: new Date(psi.timestamp).toUTCString() };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "https://x");
  const at = url.searchParams.get("at") || latestSlot();   // ?at=2026-10-19T08:00:00 replays one slot
  const [psi, pm] = await Promise.all([reading("psi", at), reading("pm25", at)]);

  let items = "";
  {
    const it = psi && pm ? buildItem(at, psi, pm) : missingItem(at, psi, pm);
    items = `<item><title>${esc(it.title)}</title><link>https://www.haze.gov.sg/</link>` +
      `<guid isPermaLink="false">${it.guid}</guid><pubDate>${it.pubDate}</pubDate>` +
      `<description><![CDATA[${it.html}]]></description>` +
      `<content:encoded><![CDATA[${it.html}]]></content:encoded></item>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>` +
    `<title>Haze Watch: Singapore PSI and PM2.5</title><link>https://www.haze.gov.sg/</link>` +
    `<description>NEA readings at ${SLOTS.join(", ")}h Singapore time</description>${items}</channel></rss>`;

  res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(xml);
};
