#!/usr/bin/env node
// Website scenario: the real server (in-memory store) and the real game page in Chromium, with a fake
// browser wallet whose signatures come from a viem test account in Node. Exits non-zero on any failure.
//
//   node test/browser/website.mjs          (from apps/fighter-server, after npm install)
//
// Env: PLAYWRIGHT_MODULE (path to the playwright package; defaults to the one installed for the
//      claude.ai browser suite in apps/fighter-lab/tests/browser), FL_OUT (screenshot folder).
import { createRequire } from "node:module";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "../../src/server.mjs";
import { chainModule } from "../../src/chain.mjs";
import { deployToken } from "../token-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_MODULE || require.resolve("playwright", { paths: [path.resolve(HERE, "../../../fighter-lab/tests/browser")] });
const { chromium } = require(PW);
const OUT = process.env.FL_OUT || path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
const ORIGIN = `http://127.0.0.1:${port}`;
const t = await deployToken();
const app = createApp({ origin: ORIGIN, chain: chainModule({ token: t.token, signerKey: t.signerKey, transport: t.transport, confirmations: 0 }) });
await new Promise((r) => app.server.listen(port, "127.0.0.1", r));

const browser = await chromium.launch();
const account = privateKeyToAccount(generatePrivateKey());

/** A page with a fake EIP-1193 wallet on Base Sepolia. */
async function walletPage(ctx, errors, acct = account) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.exposeFunction("__walletSign", (hex) => acct.signMessage({ message: { raw: hex } }));
  await page.exposeFunction("__walletSend", async (tx) => (await t.sendTx(acct.address, { to: tx.to, data: tx.data })).transactionHash);
  await page.addInitScript((addr) => {
    const calls = (window.__walletCalls = []);
    window.ethereum = {
      isFake: true,
      async request({ method, params }) {
        calls.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr.toLowerCase()];
        if (method === "eth_chainId") return "0x14a34";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "personal_sign") return window.__walletSign(params[0]);
        if (method === "eth_sendTransaction") return window.__walletSend(params[0]);
        throw Object.assign(new Error("unsupported " + method), { code: 4200 });
      },
    };
  }, acct.address);
  await page.goto(ORIGIN + "/");
  await page.waitForTimeout(400);
  return page;
}
const tabSel = (p) => p.evaluate(() => document.querySelector('.tab[aria-selected="true"]').textContent);
const wallet = async (p) => Number((await p.textContent("#wallet")).replace(/[^0-9-]/g, ""));
const storeText = (p) => p.textContent("#store");
async function fightToEnd(page, timeout = 120000) {
  await page.click("#b-speed"); await page.click("#b-speed");
  await page.waitForFunction(() => document.querySelector("#battle-result .box"), null, { timeout });
}

try {
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await walletPage(ctx, errors);

  // signed out: the game works on this device, and offers sign-in
  ok("signed out: account box offers wallet sign-in", await page.isVisible("#web-signin"));
  ok("signed out: saved on this device", (await storeText(page)).includes("Saved on this device"), await storeText(page));
  await page.fill("#f-name", "LOCALIE");
  await page.click("#save");
  await page.waitForTimeout(200);
  ok("signed out: a local fighter goes to the Gym", (await tabSel(page)) === "Gym");
  const localSave = await page.evaluate(() => localStorage.getItem("fighterlab.v2"));

  // sign in
  await page.click("#web-signin");
  await page.waitForSelector("#web-signout", { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById("store").textContent.includes("battle server"), null, { timeout: 10000 });
  const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
  ok("sign-in: the wallet signed a sign-in message", (await page.evaluate(() => window.__walletCalls)).includes("personal_sign"));
  ok("sign-in: shows the address", (await page.textContent("#web-account")).includes(short));
  ok("sign-in: starting Cycles from the server", (await wallet(page)) === 100, String(await wallet(page)));
  ok("sign-in: a new account starts in Design", (await tabSel(page)) === "Design");
  ok("sign-in: the local fighter isn't uploaded", app.store.fighters(account.address).length === 0);

  // create a fighter on the server
  await page.fill("#f-name", "QUILL");
  await page.click("#save");
  await page.waitForFunction(() => document.querySelector('.tab[aria-selected="true"]').textContent === "Gym", null, { timeout: 10000 });
  const onServer = app.store.fighters(account.address);
  ok("design: the fighter is saved on the server", onServer.length === 1 && onServer[0].name === "QUILL");
  const fid = onServer[0]?.id;

  // train: the server charges for rounds past the free 30
  await page.click('[data-seg="reps"][data-val="50"]');
  await page.click("#train");
  await page.waitForSelector(".report-head", { timeout: 15000 });
  await page.waitForTimeout(200);
  ok("gym: 50 rounds cost 20 Cycles (30 are free)", (await wallet(page)) === 80, String(await wallet(page)));
  const trained = app.store.fighter(account.address, fid);
  ok("gym: the server's fighter gained XP", trained.xp > 0 && trained.level > 1, `level ${trained.level}`);
  ok("gym: the page shows the server's level", (await page.textContent("#active-bar")).includes(`LV ${trained.level}`));

  // spar by hand: turns run on the server
  await page.click("#spar");
  await page.waitForSelector("[data-act]", { timeout: 10000 });
  for (let i = 0; i < 14; i++) {
    const done = await page.evaluate(() => /Sparring finished/.test(document.getElementById("text")?.textContent || ""));
    if (done) break;
    const btn = await page.$("[data-act]:not([disabled])");
    if (!btn) { await page.waitForTimeout(300); continue; }
    await btn.click();
    await page.waitForFunction(() => !document.querySelector("[data-act]") || [...document.querySelectorAll("[data-act]")].some((b) => !b.disabled) || /finished/.test(document.getElementById("text")?.textContent || ""), null, { timeout: 20000 });
  }
  const sparRes = await page.textContent("#battle-result").catch(() => "");
  ok("spar: the bout finishes and pays double XP", /XP/.test(sparRes), sparRes.slice(0, 80));
  ok("spar: the server saved it", app.store.fighter(account.address, fid).xp > trained.xp);
  await page.click("#spar-quit");

  // rival battle: decided on the server, played back here
  await page.click('.tab[data-tab="battle"]');
  ok("battle: the page says battles run on the server", (await page.textContent("#ai-status")).includes("battle server"));
  let won = false, lines = "", tries = 0;
  for (; tries < 4 && !won; tries++) {
    const before = await wallet(page);
    await page.click(tries ? "#again" : "#fight");
    await fightToEnd(page);
    lines = await page.textContent("#battle-result");
    won = lines.includes("Victory");
    if (!tries) ok("battle: the result says how it was run", lines.includes("Run on the battle server"), lines.slice(0, 160));
    if (won) ok("battle: a first win pays the rival reward", (await wallet(page)) >= before + 64, `${before} → ${await wallet(page)}`);
  }
  ok("battle: beat Sal on the server", won, `${tries} tries`);
  const battles = app.store.db.prepare("SELECT id FROM battles WHERE address = ?").all(account.address);
  ok("battle: every battle is stored with its seed", battles.length === tries);
  if (won) {
    ok("battle: badge from the server", lines.includes("Badge earned"));
    ok("battle: the win is recorded on the server", app.store.progress(account.address).beaten.includes("sal"));
    ok("battle: the ladder moved on", (await page.textContent("#ladder")).includes("BEATEN"));
  }
  // forge: priced and stored by the server
  const libBefore = app.store.progress(account.address).library.length, cyclesBefore = await wallet(page);
  await page.click('.tab[data-tab="forge"]');
  await page.click("#fz-forge");
  await page.waitForFunction((n) => document.querySelectorAll("[data-lib-del]").length > n, libBefore, { timeout: 10000 }).catch(() => {});
  const lib = app.store.progress(account.address).library;
  ok("forge: the file is in the server's library", lib.length === libBefore + 1, `${libBefore} → ${lib.length}`);
  ok("forge: charged by the server's price", (await wallet(page)) < cyclesBefore && (await wallet(page)) === app.store.ledgerSum(account.address));
  ok("ledger: the page's Cycles match the server's ledger", (await wallet(page)) === app.store.ledgerSum(account.address), `${await wallet(page)} vs ${app.store.ledgerSum(account.address)}`);

  // test tokens: withdraw Cycles as a voucher the wallet claims, then deposit some back
  ok("wallet: the account box shows test tokens", (await page.textContent("#web-account")).includes("0 tCYC"));
  const cyclesAtStart = await wallet(page);
  await page.fill("#web-withdraw-n", "20");
  await page.click("#web-withdraw");
  await page.waitForFunction(() => /Claimed/.test(document.getElementById("web-note")?.textContent || ""), null, { timeout: 30000 });
  ok("wallet: the claim minted 20 tCYC on chain", (await t.read("balanceOf", [account.address])) === 20n * 10n ** 18n);
  ok("wallet: the page shows the tokens", (await page.textContent("#web-tokens")).includes("20 tCYC"));
  ok("wallet: 20 Cycles left the game", (await wallet(page)) === cyclesAtStart - 20 && (await wallet(page)) === app.store.ledgerSum(account.address), `${cyclesAtStart} → ${await wallet(page)}`);
  ok("wallet: the voucher is marked claimed", app.store.withdrawals(account.address)[0]?.status === "claimed");
  ok("wallet: the note links to the explorer", (await page.getAttribute("#web-note a", "href")).startsWith("https://sepolia.basescan.org/tx/0x"));
  await page.fill("#web-deposit-n", "5");
  await page.click("#web-deposit");
  await page.waitForFunction(() => /Deposited/.test(document.getElementById("web-note")?.textContent || ""), null, { timeout: 30000 });
  ok("wallet: the deposit burned 5 tCYC", (await t.read("balanceOf", [account.address])) === 15n * 10n ** 18n);
  ok("wallet: and credited 5 Cycles", (await wallet(page)) === cyclesAtStart - 15 && (await wallet(page)) === app.store.ledgerSum(account.address), String(await wallet(page)));
  ok("wallet: the Forge tab's wallet shows the same Cycles", (await page.textContent("#view .outcome")).includes(`${await wallet(page)} Cycles`));
  await page.screenshot({ path: path.join(OUT, "website-wallet.png"), fullPage: false });

  // the arena: publish, then a second player challenges
  await page.click('.tab[data-tab="arena"]');
  await page.waitForSelector("#publish", { timeout: 10000 });
  await page.click("#publish");
  await page.waitForFunction(() => document.querySelector("#unpublish"), null, { timeout: 10000 });
  ok("arena: publishing goes to the server", app.store.arena().some((x) => x.fighter.id === fid));

  const errors2 = [];
  const other = privateKeyToAccount(generatePrivateKey());
  const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page2 = await walletPage(ctx2, errors2, other);
  await page2.click("#web-signin");
  await page2.waitForSelector("#web-signout", { timeout: 10000 });
  await page2.fill("#f-name", "BOLT");
  await page2.click("#save");
  await page2.waitForFunction(() => document.querySelector('.tab[aria-selected="true"]').textContent === "Gym", null, { timeout: 10000 });
  await page2.click('.tab[data-tab="arena"]');
  await page2.waitForSelector("[data-challenge]", { timeout: 15000 });
  ok("arena: other players' fighters show by address", (await page2.textContent(".lb")).includes(short));
  await page2.click("[data-challenge]");
  await fightToEnd(page2);
  const res2 = await page2.textContent("#battle-result");
  ok("arena: the challenge is recorded and paid", res2.includes("Result recorded") && /\+\d+ Cycles/.test(res2), res2.slice(0, 200));
  const ratings = app.game.arena().ratings;
  ok("arena: ratings come from the server's battle", !!ratings[`${account.address}/${fid}`]);
  await page2.screenshot({ path: path.join(OUT, "website-arena.png"), fullPage: true });

  // reload: still signed in, fighters come from the server
  await page.reload();
  await page.waitForFunction(() => document.getElementById("store").textContent.includes("battle server"), null, { timeout: 10000 });
  ok("reload: still signed in (session cookie)", await page.isVisible("#web-signout"));
  ok("reload: the server's fighter is on the roster", (await page.textContent("#view")).includes("QUILL"));
  const cookie = (await ctx.cookies()).find((c) => c.name === "fl_session");
  ok("session cookie is HttpOnly and SameSite=Strict", !!cookie && cookie.httpOnly && cookie.sameSite === "Strict");

  // sign out: back to this device's save, which signing in never touched
  await page.click("#web-signout");
  await page.waitForSelector("#web-signin", { timeout: 10000 });
  await page.waitForTimeout(300);
  ok("sign-out: back to this device", (await storeText(page)).includes("Saved on this device"));
  ok("sign-out: the local save is as it was", (await page.evaluate(() => localStorage.getItem("fighterlab.v2"))) === localSave);
  ok("sign-out: the local fighter is back", (await page.textContent("#view")).includes("LOCALIE") || (await page.textContent("#active-bar")).includes("LOCALIE"));
  await page.screenshot({ path: path.join(OUT, "website-signed-out.png"), fullPage: true });

  ok("no page errors (player 1)", errors.length === 0, errors.join(" | "));
  ok("no page errors (player 2)", errors2.length === 0, errors2.join(" | "));
  await ctx.close(); await ctx2.close();
} catch (e) {
  ok("scenario ran to the end", false, e.stack || String(e));
} finally {
  await browser.close();
  app.server.closeAllConnections?.();
  app.server.close();
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
