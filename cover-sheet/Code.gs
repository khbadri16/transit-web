/**
 * Clients sheet — one line per client, added by the Folder cover
 * ---------------------------------------------------------------
 * Every cover generated on the site (from any computer) sends its line here.
 * A cover printed again for the same BL updates that line (the "Date added"
 * stays the first one) instead of adding a second line. A cover without a BL
 * can't be matched: each print adds a new line.
 *
 * Setup (once):
 *   1. Create a Google Sheet (sheets.google.com -> Blank).
 *   2. In the sheet: Extensions -> Apps Script. Delete what is there and paste
 *      this whole file. Change SECRET below to a word of your choice.
 *      Save (disk icon).
 *   3. Deploy -> New deployment -> gear icon -> Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Deploy -> Authorize access -> choose your Google account. If Google says
 *      "Google hasn't verified this app": Advanced -> Go to ... (unsafe).
 *      Google then says the script can see and edit your spreadsheets: Allow
 *      (it is your own script; the code only writes in this sheet).
 *   4. Copy the "Web app" URL (ends with /exec). Opening it in a browser
 *      shows "Clients sheet: ready."
 *   5. In Vercel -> the project -> Settings -> Environment Variables, add:
 *        COVER_SHEET_URL     = the URL from step 4
 *        COVER_SHEET_SECRET  = the same word as SECRET below
 *      Then redeploy the site.
 *   6. To let colleagues open the table: Share (top right of the sheet) ->
 *      add their Gmail addresses (Viewer, or Editor to correct lines).
 *      Covers from every computer are written here either way.
 *
 * Changing this code later: Deploy -> Manage deployments -> edit (pencil) ->
 * Version: New version -> Deploy. The URL stays the same.
 */

const SECRET = "CHANGE-ME";

const TAB = "Clients";
const HEADERS = [
  "Date added", "Client", "Appartient à", "Shipping line", "BL",
  "Containers", "Packages", "Weight (kg)", "Goods", "Depot",
];
const BL_COL = 5; // column E

/** Opening the URL in a browser shows this — a quick check that it works. */
function doGet() {
  return ContentService.createTextOutput("Clients sheet: ready.");
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch (err) {
    return reply_({ ok: false, error: "bad request" });
  }
  if (SECRET === "CHANGE-ME") {
    return reply_({ ok: false, error: "SECRET in the Apps Script is still CHANGE-ME: set your own word there and in COVER_SHEET_SECRET, then deploy a new version" });
  }
  if (body.secret !== SECRET) {
    return reply_({ ok: false, error: "wrong secret (SECRET in the Apps Script and COVER_SHEET_SECRET in Vercel must be the same word)" });
  }

  // two covers made at the same second on two computers: one after the other
  // (shorter than the server's 20 s wait, so a busy sheet is reported as busy)
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return reply_({ ok: false, error: "the sheet is busy, try again" });
  }
  try {
    const sheet = tab_();
    // B..J — everything except "Date added"
    const values = [
      text_(body.client), text_(body.belongs_to), text_(body.line), text_(body.bl),
      text_(body.containers), number_(body.packages), number_(body.weight), text_(body.goods), text_(body.depot),
    ];
    const formats = values.map(function (v) {
      if (typeof v !== "number") return "@";       // kept exactly as sent (a BL of digits stays text)
      return Number.isInteger(v) ? "#,##0" : "#,##0.###";
    });

    let at = findBl_(sheet, body.bl);
    const action = at ? "updated" : "added";
    if (at) {
      // same BL printed again: update the line, "Date added" stays the first one
      sheet.getRange(at, 2, 1, values.length).setNumberFormats([formats]).setValues([values]);
    } else {
      at = sheet.getLastRow() + 1;
      // a new sheet has 1000 rows: add room when the table reaches the end
      if (at > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 500);
      // the whole line in one write: a failed write leaves no half line
      sheet.getRange(at, 1, 1, values.length + 1)
        .setNumberFormats([["dd/MM/yyyy HH:mm"].concat(formats)])
        .setValues([[new Date()].concat(values)]);
    }
    SpreadsheetApp.flush();
    return reply_({ ok: true, action: action, row: at });
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** The "Clients" tab, created (with its header row) the first time. */
function tab_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TAB);
  if (!sheet) {
    const sheets = ss.getSheets();
    // a brand-new spreadsheet: reuse its empty first tab
    sheet = sheets.length === 1 && sheets[0].getLastRow() === 0
      ? sheets[0].setName(TAB)
      : ss.insertSheet(TAB);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.getRange("F:F").setWrap(true); // containers: one line per size
  }
  return sheet;
}

/** Row number of the line with this BL (the last one if several), or 0. */
function findBl_(sheet, bl) {
  const key = blKey_(bl);
  const last = sheet.getLastRow();
  if (!key || last < 2) return 0;
  const bls = sheet.getRange(2, BL_COL, last - 1, 1).getDisplayValues();
  for (let i = bls.length - 1; i >= 0; i--) {
    if (blKey_(bls[i][0]) === key) return i + 2;
  }
  return 0;
}

/** "hdmu nboa-7731250" and "HDMUNBOA7731250" are the same BL. */
function blKey_(v) {
  return String(v === undefined || v === null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A text that starts with "=" would become a formula: keep it as text. */
function text_(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return s.charAt(0) === "=" ? "'" + s : s;
}

/** Packages / weight: a number stays a number (sums work), anything else is text. */
function number_(v) {
  return typeof v === "number" && isFinite(v) ? v : text_(v);
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
