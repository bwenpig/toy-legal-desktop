"use strict";
(() => {
  // web-src/version.ts
  var APP_VERSION = "3.15.1";

  // web-src/money.ts
  var asCents = (n) => n;
  function toCents(input) {
    let s = String(input ?? "").trim().replace(/[,\s]/g, "");
    s = s.replace(/^(?:HK)?\$/i, "");
    if (!s) return asCents(0);
    let neg = false;
    if (s[0] === "-") {
      neg = true;
      s = s.slice(1);
    } else if (s[0] === "+") {
      s = s.slice(1);
    }
    const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m) {
      const f = Number(s);
      return asCents(Number.isFinite(f) ? Math.round(f * 100) : 0);
    }
    const intPart = m[1] || "0";
    let frac = m[2] || "";
    let roundUp = false;
    if (frac.length > 2) {
      roundUp = frac[2] >= "5";
      frac = frac.slice(0, 2);
    }
    frac = (frac + "00").slice(0, 2);
    let cents = parseInt(intPart, 10) * 100 + parseInt(frac, 10);
    if (roundUp) cents += 1;
    return asCents(neg ? -cents : cents);
  }
  function dollarsToCents(dollars3) {
    if (!Number.isFinite(dollars3)) return asCents(0);
    return toCents(String(dollars3));
  }
  function fromCents(cents) {
    const c = Math.trunc(cents);
    const neg = c < 0;
    const abs = Math.abs(c);
    return (neg ? "-" : "") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  }
  var groupThousands = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  function formatCentsAbs(cents) {
    const c = Math.trunc(Number(cents) || 0);
    const abs = Math.abs(c);
    return groupThousands(String(Math.floor(abs / 100))) + "." + String(abs % 100).padStart(2, "0");
  }
  function formatCentsSigned(cents) {
    const c = Math.trunc(Number(cents) || 0);
    return (c < 0 ? "-" : "") + formatCentsAbs(c);
  }
  function csvDollars(cents) {
    return String(Math.trunc(cents) / 100);
  }
  function convertLegacyMoneyToCents(data) {
    let n = 0;
    const c = (v) => {
      n++;
      return dollarsToCents(Number(v) || 0);
    };
    const voucherLines = (v) => v.lines.forEach((l) => {
      l.debit = c(l.debit);
      l.credit = c(l.credit);
    });
    data.vouchers.forEach(voucherLines);
    if (data.workingVoucher) voucherLines(data.workingVoucher);
    data.accounts.forEach((a) => {
      a.balance = c(a.balance);
      a.importedBalance = c(a.importedBalance);
    });
    const invoiceRow = (r) => {
      r[3] = c(r[3]);
    };
    (data.salesInvoices || []).forEach(invoiceRow);
    (data.purchaseInvoices || []).forEach(invoiceRow);
    (data.allocations || []).forEach((x) => {
      x.amount = c(x.amount);
    });
    (data.allocationReview || []).forEach((x) => {
      x.amount = c(x.amount);
    });
    Object.values(data.balanceAdjustments || {}).forEach((year) => {
      if (year) Object.keys(year).forEach((k) => {
        year[k] = c(year[k]);
      });
    });
    Object.values(data.openingBalances || {}).forEach((year) => {
      if (!year) return;
      Object.keys(year).forEach((k) => {
        const e = year[k];
        if (typeof e === "number") year[k] = { debit: c(e), credit: 0 };
        else {
          e.debit = c(e.debit);
          e.credit = c(e.credit);
        }
      });
    });
    Object.values(data.openingInvoiceDetails || {}).forEach((year) => {
      if (!year) return;
      Object.values(year).forEach((items) => items.forEach((it) => {
        it.amount = c(it.amount);
      }));
    });
    Object.values(data.reconciliationConfirmations || {}).forEach((r) => {
      r.invoiceOutstanding = c(r.invoiceOutstanding);
      r.accountBalance = c(r.accountBalance);
      r.difference = c(r.difference);
    });
    return n;
  }

  // web-src/core/fiscal.ts
  function makeFiscalYear(start) {
    const s = Number(start);
    return {
      start: s,
      key: String(start),
      label: `FY${start}/${String(s + 1).slice(-2)}`,
      from: `${start}-04-01`,
      to: `${s + 1}-03-31`
    };
  }
  function fiscalYearForDate(date) {
    const year = Number(String(date).slice(0, 4));
    const month = Number(String(date).slice(5, 7));
    return makeFiscalYear(month >= 4 ? year : year - 1);
  }
  function dateInFiscalYear(date, fy) {
    return Boolean(date && fy && date >= fy.from && date <= fy.to);
  }

  // web-src/vouchers.ts
  function renderAccountOptions() {
    sortAccounts();
  }
  function syncAccountSelectors() {
    sortAccounts();
    renderAccountOptions();
    renderLedger();
    if (!openingManager.hidden) renderOpeningBalances();
    validate();
  }
  function accountsChanged() {
    syncAccountSelectors();
    renderAccounts();
    renderReport();
    renderKPIs();
  }
  function resolveAccount(value) {
    const term = String(value || "").trim().toLowerCase();
    return store.accounts.find((a) => a.name.toLowerCase() === term || a.code.toLowerCase() === term);
  }
  function renderInvoiceNumberList() {
    const fy = selectedFiscalYear(), opening = Object.entries(store.openingInvoiceDetails[fy.key] || {}).flatMap(([accountName, items]) => openingInvoiceStatus(accountName, fy).state === "complete" ? items.map((item) => [item.date, item.invoiceNo, accountName.replace(/^Accounts (Receivable|Payable) of /, ""), item.amount, "opening"]) : []);
    document.getElementById("invoiceNumberList").innerHTML = [...store.salesInvoices, ...store.purchaseInvoices, ...opening].filter((r) => (r[4] === "opening" || dateInFiscalYear2(r[0], fy)) && r[1] && r[1] !== "\u2014").map((r) => `<option value="${esc(r[1])}">${esc(r[2])}</option>`).join("");
  }
  function normalizeAttachments(voucher) {
    const atts = voucher && voucher.attachments;
    if (Array.isArray(atts)) return atts.filter((item) => item && item.dataURL).map((item) => ({ name: item.name || "attachment", type: item.type || "application/octet-stream", dataURL: String(item.dataURL) }));
    const legacy = voucher && voucher.supportingAttachment;
    if (legacy && legacy.data && voucher) return [{ name: legacy.name || voucher.supportingName || "attachment", type: legacy.type || "application/octet-stream", dataURL: String(legacy.data) }];
    return [];
  }
  function renderCurrentAttachments() {
    const box = document.getElementById("attachmentList");
    box.innerHTML = store.currentAttachments.length ? store.currentAttachments.map((item, index) => `<div class="attachment-item"><span class="attachment-item-name">${esc(item.name)}</span><button class="btn danger remove-attachment" type="button" data-index="${index}">\u522A\u9664</button></div>`).join("") : '<div class="muted" style="font-size:11px">\u672A\u9078\u64C7\u6587\u4EF6</div>';
    box.querySelectorAll(".remove-attachment").forEach((button) => button.addEventListener("click", () => {
      store.currentAttachments.splice(Number(button.dataset.index), 1);
      renderCurrentAttachments();
    }));
    document.getElementById("voucherFile").value = "";
  }
  function fileToAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name || "attachment", type: file.type || "application/octet-stream", dataURL: String(reader.result) });
      reader.onerror = () => reject(new Error("\u9644\u4EF6\u8B80\u53D6\u5931\u6557\uFF1A" + (file.name || "\u672A\u547D\u540D\u6587\u4EF6")));
      reader.readAsDataURL(file);
    });
  }
  function attachmentButtonHTML(voucherIndex) {
    const list = normalizeAttachments(store.vouchers[voucherIndex]);
    return list.length ? `<button class="attachment-btn" type="button" data-voucher-index="${voucherIndex}" aria-label="\u67E5\u770B ${list.length} \u500B\u9644\u4EF6">\u{1F4CE} ${list.length}</button>` : "";
  }
  function bindAttachmentButtons(root = document) {
    root.querySelectorAll(".attachment-btn").forEach((button) => button.addEventListener("click", () => openAttachmentList(Number(button.dataset.voucherIndex))));
  }
  function openAttachmentFile(attachment) {
    const popup = window.open("", "_blank");
    if (!popup || popup.closed) return;
    try {
      const file = dataURLToFile({ name: attachment.name, type: attachment.type, data: attachment.dataURL }), url = URL.createObjectURL(file), title = esc(attachment.name), content = String(attachment.type || "").startsWith("image/") ? `<img src="${url}" alt="${title}">` : `<iframe src="${url}" title="${title}"></iframe>`;
      popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;min-height:100%;background:#202124;color:#fff}body{display:grid;place-items:center}img{display:block;max-width:100%;max-height:100vh}iframe{width:100vw;height:100vh;border:0;background:#fff}</style></head><body>${content}</body></html>`);
      popup.document.close();
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1e3);
    } catch (error) {
      popup.close();
    }
  }
  function openAttachmentList(voucherIndex) {
    const voucher = store.vouchers[voucherIndex], list = normalizeAttachments(voucher);
    if (!voucher || !list.length) return;
    document.getElementById("attachmentModalTitle").textContent = `${voucher.no} \xB7 ${list.length} \u500B\u9644\u4EF6`;
    document.getElementById("attachmentModalHelp").textContent = "\u64B3\u6A94\u540D\u6703\u55BA\u65B0\u8996\u7A97\u958B\u555F\u5716\u7247\u6216 PDF\u3002";
    const box = document.getElementById("attachmentModalList");
    box.innerHTML = list.map((item, index) => `<button class="btn attachment-open" type="button" data-index="${index}"><span>${esc(item.name)}</span><small>\u958B\u555F \u2197</small></button>`).join("");
    box.querySelectorAll(".attachment-open").forEach((button) => button.addEventListener("click", () => openAttachmentFile(list[Number(button.dataset.index)])));
    document.getElementById("attachmentModal").hidden = false;
    document.getElementById("closeAttachmentModal").focus();
  }
  function closeAttachmentList() {
    document.getElementById("attachmentModal").hidden = true;
  }
  function updateVoucherMode() {
    const editing = store.editingIndex !== null;
    document.getElementById("postPanelTitle").textContent = editing ? "\u4FEE\u6539\u4E26\u91CD\u65B0\u904E\u8CEC" : "\u904E\u8CEC\u524D\u6AA2\u67E5";
    document.getElementById("postBtn").textContent = editing ? "\u5132\u5B58\u4FEE\u6539\u4E26\u91CD\u65B0\u904E\u8CEC" : "\u904E\u8CEC\u5230 General Ledger";
  }
  function setVoucher(data, index = store.vouchers.indexOf(data), rememberDate = false) {
    const safeIndex = index ?? -1;
    store.editingIndex = safeIndex >= 0 ? safeIndex : null;
    store.currentType = data.type;
    store.numberManuallyEdited = Boolean(data.numberManual);
    document.querySelectorAll("[data-vtype]").forEach((b) => b.classList.toggle("active", b.dataset.vtype === store.currentType));
    document.getElementById("voucherTitle").textContent = store.currentType === "B" ? "BANK VOUCHER" : "TRANSFER VOUCHER";
    document.getElementById("voucherDate").value = data.date;
    if (rememberDate && data.date) store.lastVoucherDates[fiscalYearForDate(data.date).key] = data.date;
    document.getElementById("voucherDesc").value = data.desc;
    document.getElementById("allocationInvoice").value = data.allocationInvoice || "";
    ["madeBy", "checkedBy", "approvedBy"].forEach((id) => document.getElementById(id).value = data[id] || "");
    store.rows = data.lines.map((x) => ({ ...x }));
    store.currentAttachments = normalizeAttachments(data);
    setNumber(data.no);
    renderCurrentAttachments();
    document.getElementById("postToast").classList.remove("show");
    updateVoucherMode();
    renderRows();
    validate();
  }
  function setNumber(no) {
    document.getElementById("voucherNo").textContent = no || "\u2014";
    document.getElementById("voucherNoInput").value = no;
  }
  function voucherNumberError() {
    const no = document.getElementById("voucherNoInput").value.trim();
    if (!no) return "\u8ACB\u8F38\u5165 Voucher number\u3002";
    if (store.vouchers.some((v, i) => i !== store.editingIndex && v.no.toLowerCase() === no.toLowerCase())) return "\u6B64 Voucher number \u5DF2\u5B58\u5728\uFF0C\u8ACB\u4F7F\u7528\u53E6\u4E00\u500B\u7DE8\u865F\u3002";
    return "";
  }
  function voucherYearSuffix(date) {
    const year = String(date || "").slice(0, 4);
    return /^\d{4}$/.test(year) ? year.slice(-2) : "";
  }
  function nextVoucherNumber(date, type = store.currentType) {
    const yy = voucherYearSuffix(date), mm = String(date || "").slice(5, 7);
    if (!yy || !/^\d{2}$/.test(mm)) return "";
    const pattern = new RegExp("^" + type + mm + "(\\d{2})" + yy + "$", "i");
    let max = 0;
    store.vouchers.forEach((v, i) => {
      if (i === store.editingIndex) return;
      const match = String(v.no || "").match(pattern);
      if (match) max = Math.max(max, Number(match[1]) || 0);
    });
    let seq = max + 1, no = "";
    do {
      no = type + mm + String(seq++).padStart(2, "0") + yy;
    } while (store.vouchers.some((v, i) => i !== store.editingIndex && v.no.toLowerCase() === no.toLowerCase()));
    return no;
  }
  function genNumber() {
    if (store.numberManuallyEdited) return;
    const fy = selectedFiscalYear(), d = document.getElementById("voucherDate").value || store.lastVoucherDates[fy.key] || (dateInFiscalYear2(todayISO, fy) ? todayISO : fy.from), no = nextVoucherNumber(d);
    if (no) setNumber(no);
    validate();
  }
  function clearApproval() {
    ["madeBy", "checkedBy", "approvedBy"].forEach((id) => document.getElementById(id).value = "");
    store.currentAttachments = [];
    renderCurrentAttachments();
    document.getElementById("postToast").classList.remove("show");
    validate();
  }
  function renderAccountChoices(list, filtered, activeIndex) {
    list.innerHTML = filtered.length ? filtered.map((account, index) => `<button class="account-option${index === activeIndex ? " active" : ""}" type="button" role="option" aria-selected="${index === activeIndex}" data-code="${esc(account.code)}"><span class="account-option-code">${esc(account.code)}</span><span class="account-option-name">${esc(account.name)}</span></button>`).join("") : '<div class="account-options-empty">\u627E\u4E0D\u5230\u76F8\u7B26\u6703\u8A08\u79D1\u76EE</div>';
    list.hidden = false;
  }
  function setupAccountCombobox(el, i) {
    const acct = el.querySelector(".acct"), list = el.querySelector(".account-options");
    let filtered = [], activeIndex = -1, blurTimer = null;
    const close = () => {
      list.hidden = true;
      acct.setAttribute("aria-expanded", "false");
      activeIndex = -1;
    };
    const filter = () => {
      const term = acct.value.trim().toLowerCase(), rank = (account) => {
        const code = account.code.toLowerCase(), name = account.name.toLowerCase();
        if (!term) return 0;
        if (code === term || name === term) return 0;
        if (code.startsWith(term) || name.startsWith(term)) return 1;
        return 2;
      };
      filtered = store.accounts.filter((account) => !term || account.code.toLowerCase().includes(term) || account.name.toLowerCase().includes(term)).sort((a, b) => rank(a) - rank(b) || accountCodeCollator.compare(a.code, b.code));
      activeIndex = filtered.length ? 0 : -1;
      renderAccountChoices(list, filtered, activeIndex);
      acct.setAttribute("aria-expanded", "true");
    };
    const select = (account) => {
      if (!account) return;
      acct.value = account.name;
      syncRow(i, el);
      close();
    };
    acct.addEventListener("focus", () => {
      filter();
      requestAnimationFrame(() => acct.select());
    });
    acct.addEventListener("input", () => {
      syncRow(i, el);
      filter();
    });
    acct.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (list.hidden) filter();
        if (!filtered.length) return;
        activeIndex = event.key === "ArrowDown" ? Math.min(activeIndex + 1, filtered.length - 1) : Math.max(activeIndex - 1, 0);
        renderAccountChoices(list, filtered, activeIndex);
        list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter" && !list.hidden && activeIndex >= 0) {
        event.preventDefault();
        select(filtered[activeIndex]);
      }
    });
    acct.addEventListener("blur", () => {
      blurTimer = setTimeout(() => {
        const match = resolveAccount(acct.value);
        if (match) {
          acct.value = match.name;
          syncRow(i, el);
        }
        close();
      }, 120);
    });
    list.addEventListener("mousedown", (event) => {
      const option = event.target.closest(".account-option");
      if (!option) return;
      event.preventDefault();
      if (blurTimer) clearTimeout(blurTimer);
      select(store.accounts.find((account) => account.code === option.dataset.code));
    });
  }
  function renderRows() {
    renderAccountOptions();
    const box = document.getElementById("entryRows");
    box.innerHTML = store.rows.map((r, i) => `<div class="entry-row" data-i="${i}"><span class="row-index">${String(i + 1).padStart(2, "0")}</span><div class="entry-account entry-field"><span class="entry-field-label">\u6703\u8A08\u79D1\u76EE Account</span><input class="acct account-combobox" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="account-options-${i}" aria-label="\u6703\u8A08\u79D1\u76EE\uFF08\u53EF\u6309\u7DE8\u865F\u6216\u540D\u7A31\u641C\u5C0B\uFF09" autocomplete="off" value="${esc(r.account)}" placeholder="\u8F38\u5165\u7DE8\u865F\u6216\u79D1\u76EE\u540D\u7A31"><div class="account-options" id="account-options-${i}" role="listbox" hidden></div></div><div class="entry-detail entry-field"><span class="entry-field-label">\u660E\u7D30 Detail</span><input class="detail" aria-label="\u660E\u7D30" value="${esc(r.detail)}"></div><div class="entry-debit entry-field"><span class="entry-field-label">\u501F\u65B9 Debit</span><input class="num debit" aria-label="\u501F\u65B9" type="number" min="0" step="0.01" value="${r.debit ? fromCents(r.debit) : ""}" placeholder="0.00"></div><div class="entry-credit entry-field"><span class="entry-field-label">\u8CB8\u65B9 Credit</span><input class="num credit" aria-label="\u8CB8\u65B9" type="number" min="0" step="0.01" value="${r.credit ? fromCents(r.credit) : ""}" placeholder="0.00"></div><button class="icon-btn remove" aria-label="\u522A\u9664\u6B64\u884C">\xD7</button></div>`).join("");
    box.querySelectorAll(".entry-row").forEach((el, i) => {
      el.querySelectorAll("input:not(.acct)").forEach((inp) => inp.addEventListener("input", () => syncRow(i, el)));
      setupAccountCombobox(el, i);
      el.querySelector(".remove").addEventListener("click", () => {
        if (store.rows.length > 2) {
          store.rows.splice(i, 1);
          renderRows();
        }
      });
    });
    validate();
  }
  function syncRow(i, el) {
    const raw = el.querySelector(".acct").value, match = resolveAccount(raw);
    store.rows[i] = { account: match ? match.name : raw, detail: el.querySelector(".detail").value, debit: toCents(el.querySelector(".debit").value), credit: toCents(el.querySelector(".credit").value) };
    validate();
  }
  function validate() {
    const dr = store.rows.reduce((s, r) => s + r.debit, 0), cr = store.rows.reduce((s, r) => s + r.credit, 0), accountsOK = store.rows.every((r) => Boolean(resolveAccount(r.account))), balanced = dr > 0 && dr === cr, noError = voucherNumberError(), numberOK = !noError, dateOK = dateInFiscalYear2(document.getElementById("voucherDate").value);
    document.getElementById("debitTotal").textContent = fmt(dr);
    document.getElementById("creditTotal").textContent = fmt(cr);
    const state = document.getElementById("balanceState");
    state.className = "balance-state " + (balanced && accountsOK ? "ok" : "bad");
    state.textContent = !accountsOK ? "\u8ACB\u5F9E\u641C\u5C0B\u7D50\u679C\u9078\u64C7\u6709\u6548\u6703\u8A08\u79D1\u76EE" : balanced ? "\u2713 \u501F\u8CB8\u5E73\u8861" : "\u5DEE\u984D HK$ " + fmt(dr - cr);
    const signed = ["madeBy", "checkedBy", "approvedBy"].every((id) => document.getElementById(id).value.trim());
    document.getElementById("voucherNoError").textContent = noError;
    document.getElementById("checkVoucherNo").style.color = numberOK ? "var(--good)" : "var(--bad)";
    document.getElementById("checkBalance").style.color = balanced && accountsOK ? "var(--good)" : "var(--bad)";
    document.getElementById("checkSign").style.color = signed ? "var(--good)" : "var(--warn)";
    document.getElementById("postBtn").disabled = !(numberOK && balanced && accountsOK && signed && dateOK);
  }
  function applyVoucherBalance(v, mult) {
    var _a, _b;
    const fy = fiscalYearForDate(v.date);
    (_a = store.balanceAdjustments)[_b = fy.key] ?? (_a[_b] = {});
    v.lines.forEach((l) => {
      const a = store.accounts.find((x) => x.name === l.account);
      if (a) {
        const delta = (l.debit - l.credit) * mult * (a.side === "dr" ? 1 : -1);
        store.balanceAdjustments[fy.key][a.name] = (store.balanceAdjustments[fy.key][a.name] || 0) + delta;
      }
    });
  }
  function clearVoucherAllocations(no) {
    for (let i = store.allocations.length - 1; i >= 0; i--) if (store.allocations[i].voucher === no) store.allocations.splice(i, 1);
    for (let i = store.allocationReview.length - 1; i >= 0; i--) if (store.allocationReview[i].voucher === no) store.allocationReview.splice(i, 1);
  }
  function renderVoucherList() {
    const q = document.getElementById("voucherSearch").value.trim().toLowerCase(), body = document.getElementById("voucherListBody");
    const visible = store.vouchers.map((v, index) => ({ v, index })).filter(({ v }) => dateInFiscalYear2(v.date) && [v.no, v.desc, v.allocationInvoice, v.madeBy, v.checkedBy, v.approvedBy].some((value) => String(value || "").toLowerCase().includes(q)));
    body.innerHTML = visible.map(({ v, index }) => `<tr><td data-label="\u65E5\u671F">${esc(v.date)}</td><td data-label="Voucher"><b>${esc(v.no)}</b></td><td data-label="\u6458\u8981">${esc(v.desc)}</td><td class="num" data-label="\u91D1\u984D">${fmt(v.lines.reduce((s, l) => s + l.debit, 0))}</td><td data-label="\u88FD\u8868\uFF0F\u8986\u6838\uFF0F\u6279\u6838">${[v.madeBy, v.checkedBy, v.approvedBy].filter(Boolean).map(esc).join(" \uFF0F ") || "\u2014"}</td><td data-label="\u64CD\u4F5C"><div class="voucher-list-actions"><button class="btn edit-voucher" type="button" data-index="${index}">\u4FEE\u6539</button></div></td></tr>`).join("") || '<tr><td colspan="6" class="empty">\u627E\u4E0D\u5230\u76F8\u7B26 Voucher</td></tr>';
    body.querySelectorAll(".edit-voucher").forEach((btn) => btn.addEventListener("click", () => {
      setVoucher(store.vouchers[Number(btn.dataset.index)], Number(btn.dataset.index), true);
      document.querySelector(".voucher-paper").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }
  function createNewVoucher() {
    const fy = selectedFiscalYear(), remembered = store.lastVoucherDates[fy.key];
    store.editingIndex = null;
    store.currentType = "B";
    store.numberManuallyEdited = false;
    document.querySelectorAll("[data-vtype]").forEach((b) => b.classList.toggle("active", b.dataset.vtype === "B"));
    document.getElementById("voucherTitle").textContent = "BANK VOUCHER";
    document.getElementById("voucherDate").value = remembered && dateInFiscalYear2(remembered, fy) ? remembered : dateInFiscalYear2(todayISO, fy) ? todayISO : fy.from;
    document.getElementById("voucherDesc").value = "";
    document.getElementById("allocationInvoice").value = "";
    store.rows = [{ account: (store.accounts.find((a) => a.code === "1000") || store.accounts[0]).name, detail: "", debit: 0, credit: 0 }, { account: (store.accounts.find((a) => a.code === "2100") || store.accounts[1]).name, detail: "", debit: 0, credit: 0 }];
    updateVoucherMode();
    genNumber();
    renderRows();
    clearApproval();
  }
  async function serializeVoucher(voucher) {
    const plain = { ...voucher }, attachments = normalizeAttachments(voucher);
    if (!attachments.length && voucher.supportingFile) {
      const saved = await fileToDataURL(voucher.supportingFile);
      if (saved) attachments.push({ name: saved.name, type: saved.type, dataURL: saved.data });
    }
    plain.attachments = attachments;
    delete plain.supportingFile;
    delete plain.supportingName;
    delete plain.supportingAttachment;
    return plain;
  }

  // web-src/core/party.ts
  function normalParty(s) {
    return String(s).toLowerCase().replace(/consultancy/g, "consultary").replace(/limited|ltd|company|co/g, "").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
  }

  // web-src/reports.ts
  function invoiceVoucherRefs(kind, invoiceNo, source, sourceVoucherNo) {
    const paymentLabel = kind === "AR" ? "\u6536\u6B3E" : "\u4ED8\u6B3E", openingRef = source === "opening" ? "\u671F\u521D\u660E\u7D30" : source === "voucher" ? sourceVoucherNo || "\u4F86\u6E90 Voucher" : "\u4F86\u6E90\u672A\u63D0\u4F9B";
    const refs = [`<span class="voucher-ref">\u958B\u7968\uFF1A<b>${esc(openingRef)}</b></span>`];
    const paymentRefs = [...new Set(store.allocations.filter((x) => x.kind === kind && x.invoiceNo === invoiceNo && dateInFiscalYear2(x.date)).map((x) => x.voucher).filter(Boolean))];
    if (paymentRefs.length) refs.push(`<span class="voucher-ref">${paymentLabel}\uFF1A${paymentRefs.map((v) => `<b>${esc(v)}</b>`).join("\u3001")}</span>`);
    else refs.push(`<span class="voucher-ref">${paymentLabel}\uFF1A<b>\u672A\u6709\u8A18\u9304</b></span>`);
    return refs.join("");
  }
  function invoiceVoucherText(kind, invoiceNo, source, sourceVoucherNo) {
    const paymentLabel = kind === "AR" ? "\u6536\u6B3E" : "\u4ED8\u6B3E", openingRef = source === "opening" ? "\u671F\u521D\u660E\u7D30" : source === "voucher" ? sourceVoucherNo || "\u4F86\u6E90 Voucher" : "\u4F86\u6E90\u672A\u63D0\u4F9B";
    const paymentRefs = [...new Set(store.allocations.filter((x) => x.kind === kind && x.invoiceNo === invoiceNo && dateInFiscalYear2(x.date)).map((x) => x.voucher).filter(Boolean))];
    return `\u958B\u7968\uFF1A${openingRef}\uFF1B${paymentLabel}\uFF1A${paymentRefs.length ? paymentRefs.join("\u3001") : "\u672A\u6709\u8A18\u9304"}`;
  }
  function partyVoucherPayments(kind, accountName) {
    const party = accountName.replace(/^Accounts (Receivable|Payable) of /, "");
    return store.vouchers.filter((v) => dateInFiscalYear2(v.date)).flatMap((v) => v.lines.filter((line) => line.account === accountName).map((line) => ({ date: v.date, voucher: v.no, amount: kind === "AR" ? line.credit : line.debit, invoices: [...new Set(store.allocations.filter((x) => x.kind === kind && x.voucher === v.no && normalParty(x.party) === normalParty(party)).map((x) => x.invoiceNo))], specified: v.allocationInvoice || "" }))).filter((x) => x.amount > 0).sort((a, b) => a.date.localeCompare(b.date) || a.voucher.localeCompare(b.voucher));
  }
  function purchaseRemark(invoiceNo) {
    const payments = store.allocations.filter((x) => x.kind === "AP" && x.invoiceNo === invoiceNo && dateInFiscalYear2(x.date)).sort((a, b) => a.date.localeCompare(b.date));
    if (!payments.length) return "\u672A\u4ED8\u6B3E";
    const last = payments[payments.length - 1], d = /* @__PURE__ */ new Date(last.date + "T00:00:00");
    return `paid on ${d.toLocaleString("en", { month: "short" })} ${d.getFullYear()}`;
  }
  function salesRemark(invoiceNo) {
    return store.invoiceRemarks[invoiceNo] || "\u672A\u6536\u6B3E";
  }
  function reportTransactionRows(isPurchase) {
    const kind = isPurchase ? "AP" : "AR", invoiceSource = isPurchase ? store.purchaseInvoices : store.salesInvoices;
    const invoices = invoiceSource.filter((r) => dateInFiscalYear2(r[0])).map((r) => ({ date: r[0], invoice: r[1], voucherHtml: invoiceVoucherRefs(kind, r[1], r[4], r[5]), voucherText: invoiceVoucherText(kind, r[1], r[4], r[5]), name: r[2], amount: r[3], remark: isPurchase ? purchaseRemark(r[1]) : salesRemark(r[1]), source: "invoice" }));
    const postings = store.vouchers.filter((v) => dateInFiscalYear2(v.date)).flatMap((v) => {
      const partyLine = v.lines.find((line) => line.account.startsWith(isPurchase ? "Accounts Payable of " : "Accounts Receivable of "));
      const party = partyLine ? partyLine.account.replace(/^Accounts (Receivable|Payable) of /, "") : v.desc;
      return v.lines.filter((line) => {
        const a = store.accounts.find((x) => x.name === line.account);
        return a && accountHasFiscalActivity(a) && (isPurchase ? a.type === "\u6210\u672C" && /purchase/i.test(a.name) && line.debit > 0 : a.type === "\u6536\u5165" && /sales/i.test(a.name) && line.credit > 0);
      }).map((line) => ({ date: v.date, invoice: v.allocationInvoice || "\u2014", voucherHtml: `<b>${esc(v.no)}</b>`, voucherText: v.no, name: party || line.detail || v.desc, amount: isPurchase ? line.debit : line.credit, remark: line.detail || v.desc || "\u76F4\u63A5\u7D93 voucher \u5165\u8CEC", source: "voucher" }));
    });
    return invoices.concat(postings).sort((a, b) => a.date.localeCompare(b.date) || a.voucherText.localeCompare(b.voucherText));
  }
  function salesChannel(row) {
    const party = String(row.name || "").trim(), normal = normalParty(party);
    const hasAR = store.accounts.some((a) => a.name.startsWith("Accounts Receivable of ") && normalParty(a.name.replace("Accounts Receivable of ", "")) === normal);
    if (hasAR) return "ar";
    if (/pmq/i.test(party)) return "pmq";
    return "online";
  }
  var reportNames = { trial: ["\u8A66\u7B97\u8868", "Trial Balance"], pl: ["\u640D\u76CA\u8868", "Profit & Loss Account"], bs: ["\u8CC7\u7522\u8CA0\u50B5\u8868", "Balance Sheet"], ar: ["\u61C9\u6536\u8CEC\u6B3E\u8CEC\u9F61\u5831\u544A", "Accounts Receivable Aging"], ap: ["\u61C9\u4ED8\u8CEC\u6B3E\u8CEC\u9F61\u5831\u544A", "Accounts Payable Aging"], purchase: ["\u63A1\u8CFC\u5831\u544A", "Purchase Report"], sales: ["\u92B7\u552E\u5831\u544A", "Sales Report"], journal: ["\u65E5\u8A18\u8CEC", "Journal"], register: ["\u6191\u8B49\u767B\u8A18\u518A", "Voucher Register"] };
  function fiscalMonths() {
    const fy = selectedFiscalYear(), months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(fy.start, i + 3, 1), year = d.getFullYear(), month = d.getMonth() + 1, last = new Date(year, month, 0).getDate(), short = d.toLocaleString("en", { month: "short" }) + " " + String(year).slice(-2), long = d.toLocaleString("en", { month: "long" }) + " " + year;
      months.push({ key: `${year}-${pad2(month)}`, short, long, end: `${last} ${d.toLocaleString("en", { month: "short" })} ${year}` });
    }
    return months;
  }
  var selectedFiscalMonth = () => {
    const mm = store.reportState.month;
    return mm ? fiscalMonths().find((m) => m.key === mm.key) : null;
  };
  var accountValue = (name, fallback = 0, types = null) => {
    const account = store.accounts.find((a) => a.name === name);
    if (account) return types && !types.includes(account.type) ? 0 : accountBalance(account);
    if (store.accounts.some((a) => a.originalName === name)) return 0;
    return selectedFiscalYear().start === 2023 && !store.deletedDataYears.has("2023") ? fallback : 0;
  };
  function currentYearProfitLoss() {
    return -fiscalAccounts().filter((a) => ["\u6536\u5165", "\u6210\u672C", "\u8CBB\u7528"].includes(a.type)).reduce((sum, a) => sum + accountSignedBalance(a), 0);
  }
  function customAccountAmount(account, cumulative) {
    const selected = selectedFiscalMonth();
    if (!selected) return accountBalance(account);
    const fy = selectedFiscalYear(), base = cumulative ? (fy.start === 2023 && !store.deletedDataYears.has(fy.key) ? account.importedBalance : 0) + openingNaturalBalance(account, fy) : 0;
    return store.vouchers.reduce((sum, v) => {
      if (!dateInFiscalYear2(v.date)) return sum;
      const month = v.date.slice(0, 7);
      if (cumulative ? month > selected.key : month !== selected.key) return sum;
      const lineTotal = v.lines.filter((line) => line.account === account.name).reduce((lineSum, line) => lineSum + (account.side === "dr" ? line.debit - line.credit : line.credit - line.debit), 0);
      return sum + lineTotal;
    }, base);
  }
  function findAccountByName(name) {
    const term = String(name || "").trim().toLowerCase();
    return store.accounts.find((account) => account.name.toLowerCase() === term || String(account.originalName || "").toLowerCase() === term);
  }
  function stockAccountAmountThrough(account, monthKey, creditNormal = false) {
    if (!account || !monthKey) return 0;
    const fy = selectedFiscalYear(), entry = openingEntry(fy, account.name), signed = (debit, credit) => creditNormal ? credit - debit : debit - credit;
    return signed(entry.debit, entry.credit) + store.vouchers.reduce((sum, voucher) => {
      if (!dateInFiscalYear2(voucher.date, fy) || voucher.date.slice(0, 7) > monthKey) return sum;
      return sum + voucher.lines.filter((line) => line.account === account.name).reduce((lineSum, line) => lineSum + signed(line.debit, line.credit), 0);
    }, 0);
  }
  function monthlyStockAmounts(selected) {
    if (!selected) return null;
    const months = fiscalMonths(), monthIndex = months.findIndex((month) => month.key === selected.key), openingAccount = findAccountByName("Opening Stock"), closingAccount = findAccountByName("Closing Stock Adjustment");
    const opening = monthIndex === 0 ? openingAccount ? stockAccountAmountThrough(openingAccount, selected.key) : 0 : closingAccount ? stockAccountAmountThrough(closingAccount, months[monthIndex - 1].key, true) : 0;
    const closing = closingAccount ? stockAccountAmountThrough(closingAccount, selected.key, true) : 0;
    return { opening, closing };
  }
  function profitLossAccountAmount(name, _fallback, _types) {
    const selected = selectedFiscalMonth(), account = findAccountByName(name);
    if (account) return selected ? customAccountAmount(account, false) : accountBalance(account);
    return 0;
  }
  function monthSelector() {
    const selected = selectedFiscalMonth(), options = fiscalMonths().map((month) => {
      const [year, number] = month.key.split("-");
      return `<option value="${month.key}" ${store.reportState.month?.key === month.key ? "selected" : ""}>${year}\u5E74${Number(number)}\u6708</option>`;
    }).join("");
    return `<div class="month-controls"><div class="month-field"><label for="reportMonthSelect">\u5831\u8868\u6708\u4EFD</label><select class="month-select" id="reportMonthSelect" aria-describedby="reportMonthHelp"><option value="" ${store.reportState.month === null ? "selected" : ""}>\u5168\u5E74</option>${options}</select></div><p class="calendar-period" id="reportMonthHelp">${selected ? "\u73FE\u6642\u986F\u793A " + selected.long : "\u73FE\u6642\u986F\u793A\u6574\u500B\u8CA1\u653F\u5E74\u5EA6"}</p></div>`;
  }
  function reportShell(body) {
    const n = reportNames[store.report];
    return `<div class="report-title"><h2>${n[0]} <span class="muted">${n[1]}</span></h2><p>Toys Gallery International Limited \xB7 HKD</p></div><div class="report-actions"><button class="btn" id="exportReport" type="button">\u4E0B\u8F09 CSV\uFF08Excel \u53EF\u958B\u555F\uFF09</button><button class="btn" id="copyReport" type="button">\u8907\u88FD CSV \u5167\u5BB9</button><span id="exportStatus" role="status" aria-live="polite">\u6CBF\u7528\u73FE\u6709 Excel \u5831\u8868\u683C\u5F0F</span></div><div class="report-body">${body}</div>`;
  }
  function sheetHeading(title) {
    return `<div class="sheet-heading"><strong>Toys Gallery International Limited</strong><span>${title}</span></div>`;
  }
  function tbRows(factor = 1) {
    return fiscalAccounts().map((a) => {
      const signed = accountSignedBalance(a) * factor;
      return `<tr><td data-label="\u79D1\u76EE">${esc(a.name)}</td><td class="num" data-label="Dr">${signed > 0 ? fmt(signed) : ""}</td><td class="num" data-label="Cr">${signed < 0 ? fmt(signed) : ""}</td></tr>`;
    }).join("");
  }
  function cellFmt(v) {
    return v === null ? "" : Number(v) < 0 ? "(" + fmt(v) + ")" : fmt(v);
  }
  function pLine(label, detail, total, cls = "") {
    return `<div class="excel-line ${cls}"><span>${label}</span><span class="num">${cellFmt(detail)}</span><span class="num">${cellFmt(total)}</span></div>`;
  }
  function bLine(label, detail, total, cls = "") {
    return `<div class="balance-line ${cls}"><span>${label}</span><span class="num">${cellFmt(detail)}</span><span class="num">${cellFmt(total)}</span></div>`;
  }
  var reconcileKey = (kind, party, month = store.reportState.month) => `${store.selectedFiscalKey}|${month?.key || "all"}|${kind}|${normalParty(party)}`;
  var periodMatches = (date) => store.reportState.month === null ? dateInFiscalYear2(date) : String(date).slice(0, 7) === store.reportState.month.key;
  function currentReconcileState(kind, party, invoiceOutstanding, accountBalance2) {
    const difference = invoiceOutstanding - Math.abs(accountBalance2), saved = store.reconciliationConfirmations[reconcileKey(kind, party)];
    const confirmed = Boolean(saved && saved.invoiceOutstanding === invoiceOutstanding && saved.accountBalance === accountBalance2 && saved.difference === difference);
    return { difference, saved, confirmed, matched: difference === 0 };
  }
  function reconcileDraftMetrics() {
    const paidByInvoice = {};
    store.reconcilePaymentDraft.forEach((p) => {
      paidByInvoice[p.invoiceNo] = (paidByInvoice[p.invoiceNo] || 0) + p.amount;
    });
    const invoiceOutstanding = store.reconcileInvoiceDraft.reduce((sum, item) => sum + Math.max(0, item.amount - (paidByInvoice[item.invoiceNo] || 0)), 0);
    const account = store.accounts.find((a) => a.name === store.reconciliationContext.accountName), accountBalance2 = account ? accountSignedBalance(account) : 0;
    return { invoiceOutstanding, accountBalance: accountBalance2, difference: invoiceOutstanding - Math.abs(accountBalance2) };
  }
  function updateReconcileSummary() {
    if (!store.reconciliationContext) return;
    const metrics = reconcileDraftMetrics();
    document.getElementById("reconcileInvoiceTotal").textContent = money(metrics.invoiceOutstanding);
    document.getElementById("reconcileAccountBalance").textContent = money(metrics.accountBalance);
    const diff = document.getElementById("reconcileDifference");
    diff.textContent = money(metrics.difference);
    diff.style.color = metrics.difference === 0 ? "var(--good)" : "var(--warn)";
  }
  function renderReconcileDraft() {
    const invoiceBox = document.getElementById("reconcileInvoiceRows"), paymentBox = document.getElementById("reconcilePaymentRows"), paymentWord = store.reconciliationContext.kind === "AR" ? "\u6536\u6B3E" : "\u4ED8\u6B3E";
    invoiceBox.innerHTML = store.reconcileInvoiceDraft.map((item, i) => `<div class="record-editor-row" data-index="${i}"><input class="recon-invoice-date" type="date" aria-label="\u767C\u7968\u65E5\u671F" value="${esc(item.date)}"><input class="recon-invoice-no" aria-label="\u767C\u7968\u865F\u78BC" value="${esc(item.invoiceNo)}" placeholder="\u767C\u7968\u865F\u78BC"><input class="recon-invoice-amount" type="number" min="0.01" step="0.01" aria-label="\u767C\u7968\u91D1\u984D" value="${item.amount ? fromCents(item.amount) : ""}" placeholder="0.00"><span class="record-origin">${item.origin === "opening" ? "\u671F\u521D\u660E\u7D30" : "\u767C\u7968\u8A18\u9304"}</span><button class="icon-btn remove-recon-invoice" type="button" aria-label="\u522A\u9664\u6B64\u767C\u7968">\xD7</button></div>`).join("") || '<div class="empty">\u672A\u6709\u767C\u7968\u8A18\u9304\uFF0C\u53EF\u6309\u300C\u65B0\u589E\u767C\u7968\u300D\u88DC\u56DE\u3002</div>';
    paymentBox.innerHTML = store.reconcilePaymentDraft.map((item, i) => `<div class="record-editor-row payment" data-index="${i}"><input class="recon-payment-date" type="date" aria-label="${paymentWord}\u65E5\u671F" value="${esc(String(item.date).length === 7 ? item.date + "-01" : item.date)}"><input class="recon-payment-voucher" aria-label="Voucher number" value="${esc(item.voucher)}" placeholder="Voucher number"><select class="recon-payment-invoice" aria-label="\u5C0D\u92B7\u767C\u7968">${store.reconcileInvoiceDraft.map((inv) => `<option value="${esc(inv.invoiceNo)}" ${inv.invoiceNo === item.invoiceNo ? "selected" : ""}>${esc(inv.invoiceNo || "\u672A\u547D\u540D\u767C\u7968")}</option>`).join("")}</select><input class="recon-payment-amount" type="number" min="0.01" step="0.01" aria-label="${paymentWord}\u91D1\u984D" value="${item.amount ? fromCents(item.amount) : ""}" placeholder="0.00"><button class="icon-btn remove-recon-payment" type="button" aria-label="\u522A\u9664\u6B64${paymentWord}\u8A18\u9304">\xD7</button></div>`).join("") || `<div class="empty">\u672A\u6709${paymentWord}\u8A18\u9304\uFF0C\u53EF\u6309\u300C\u65B0\u589E\u8A18\u9304\u300D\u88DC\u56DE\u3002</div>`;
    invoiceBox.querySelectorAll(".record-editor-row").forEach((row, i) => {
      const sync = () => {
        store.reconcileInvoiceDraft[i].date = row.querySelector(".recon-invoice-date").value;
        store.reconcileInvoiceDraft[i].invoiceNo = row.querySelector(".recon-invoice-no").value.trim();
        store.reconcileInvoiceDraft[i].amount = toCents(row.querySelector(".recon-invoice-amount").value);
        renderReconcilePaymentOptions();
        updateReconcileSummary();
      };
      row.querySelectorAll("input").forEach((input) => input.addEventListener("input", sync));
      row.querySelector(".remove-recon-invoice").addEventListener("click", () => {
        const removed = store.reconcileInvoiceDraft.splice(i, 1)[0];
        store.reconcilePaymentDraft = store.reconcilePaymentDraft.filter((p) => p.invoiceNo !== removed.invoiceNo);
        renderReconcileDraft();
      });
    });
    paymentBox.querySelectorAll(".record-editor-row").forEach((row, i) => {
      const sync = () => {
        store.reconcilePaymentDraft[i] = { ...store.reconcilePaymentDraft[i], date: row.querySelector(".recon-payment-date").value, voucher: row.querySelector(".recon-payment-voucher").value.trim(), invoiceNo: row.querySelector(".recon-payment-invoice").value, amount: toCents(row.querySelector(".recon-payment-amount").value) };
        updateReconcileSummary();
      };
      row.querySelectorAll("input,select").forEach((input) => input.addEventListener("input", sync));
      row.querySelector(".remove-recon-payment").addEventListener("click", () => {
        store.reconcilePaymentDraft.splice(i, 1);
        renderReconcileDraft();
      });
    });
    updateReconcileSummary();
  }
  function renderReconcilePaymentOptions() {
    document.querySelectorAll(".recon-payment-invoice").forEach((select, i) => {
      const current = store.reconcilePaymentDraft[i] && store.reconcilePaymentDraft[i].invoiceNo;
      select.innerHTML = store.reconcileInvoiceDraft.map((inv) => `<option value="${esc(inv.invoiceNo)}" ${inv.invoiceNo === current ? "selected" : ""}>${esc(inv.invoiceNo || "\u672A\u547D\u540D\u767C\u7968")}</option>`).join("");
      if (store.reconcilePaymentDraft[i] && !store.reconcileInvoiceDraft.some((inv) => inv.invoiceNo === current)) store.reconcilePaymentDraft[i].invoiceNo = store.reconcileInvoiceDraft[0] ? store.reconcileInvoiceDraft[0].invoiceNo : "";
    });
  }
  function openReconciliation(kind, accountName, party) {
    const source = kind === "AR" ? store.salesInvoices : store.purchaseInvoices, storedOpening = (store.openingInvoiceDetails[store.selectedFiscalKey] || {})[accountName] || [], opening = storedOpening.map((item) => ({ date: item.date, invoiceNo: item.invoiceNo, amount: item.amount, origin: "opening" })), openingStatus = openingInvoiceStatus(accountName);
    store.reconciliationContext = { kind, accountName, party, month: store.reportState.month ? { ...store.reportState.month } : null, openingWasDisplayed: opening.length > 0 };
    store.reconcileInvoiceDraft = source.filter((r) => dateInFiscalYear2(r[0]) && periodMatches(r[0]) && normalParty(r[2]) === normalParty(party)).map((r) => ({ date: r[0], invoiceNo: r[1], amount: r[3], origin: "invoice" })).concat(opening);
    const invoiceNos = new Set(store.reconcileInvoiceDraft.map((r) => r.invoiceNo));
    store.reconcilePaymentDraft = store.allocations.filter((x) => x.kind === kind && normalParty(x.party) === normalParty(party) && periodMatches(x.date) && invoiceNos.has(x.invoiceNo)).map((x) => ({ date: String(x.date).length === 7 ? x.date + "-01" : x.date, voucher: x.voucher || "", invoiceNo: x.invoiceNo, amount: x.amount, source: x.source || "\u4EBA\u5DE5\u8A18\u9304" }));
    const saved = store.reconciliationConfirmations[reconcileKey(kind, party, store.reconciliationContext.month)], word = kind === "AR" ? "\u61C9\u6536\u8CEC\u6B3E" : "\u61C9\u4ED8\u8CEC\u6B3E";
    document.getElementById("reconcileTitle").textContent = `${word}\u6838\u5C0D \xB7 ${party}`;
    document.getElementById("reconcileHelp").textContent = "\u53EF\u88DC\u52A0\u3001\u4FEE\u6539\u6216\u522A\u9664\u767C\u7968\u53CA" + (kind === "AR" ? "\u6536\u6B3E" : "\u4ED8\u6B3E") + "\u8A18\u9304\uFF1B\u5DEE\u984D\u6703\u5373\u6642\u91CD\u8A08\u3002";
    document.getElementById("reconcilePaymentHeading").textContent = kind === "AR" ? "\u6536\u6B3E\u8A18\u9304" : "\u4ED8\u6B3E\u8A18\u9304";
    document.getElementById("reconcileConfirmedBy").value = saved ? saved.confirmedBy : "";
    document.getElementById("reconcileConfirmedDate").value = saved ? saved.date : todayISO;
    document.getElementById("reconcileNote").value = saved ? saved.note : "";
    document.getElementById("reconcileMessage").textContent = "";
    document.getElementById("reconcileMessage").className = "form-message";
    document.getElementById("reconcileOpeningPendingNotice").hidden = openingStatus.state !== "pending";
    document.getElementById("reconcileModal").hidden = false;
    renderReconcileDraft();
    document.getElementById("reconcileConfirmedBy").focus();
  }
  function validateReconcileDraft() {
    const invoiceNos = store.reconcileInvoiceDraft.map((x) => x.invoiceNo.trim()), completeInvoices = store.reconcileInvoiceDraft.every((x) => x.date && x.invoiceNo.trim() && x.amount > 0), uniqueInvoices = new Set(invoiceNos.map((x) => x.toLowerCase())).size === invoiceNos.length, completePayments = store.reconcilePaymentDraft.every((x) => x.date && x.voucher.trim() && invoiceNos.includes(x.invoiceNo) && x.amount > 0);
    let error = "";
    if (!completeInvoices) error = "\u8ACB\u5B8C\u6210\u6BCF\u5F35\u767C\u7968\u7684\u65E5\u671F\u3001\u7DE8\u865F\u53CA\u91D1\u984D\u3002";
    else if (!uniqueInvoices) error = "\u540C\u4E00\u5BA2\u6236\uFF0F\u4F9B\u61C9\u5546\u7684\u767C\u7968\u865F\u78BC\u4E0D\u53EF\u91CD\u8907\u3002";
    else if (!completePayments) error = "\u8ACB\u5B8C\u6210\u6BCF\u7B46\u6536\uFF0F\u4ED8\u6B3E\u7684\u65E5\u671F\u3001Voucher\u3001\u5C0D\u92B7\u767C\u7968\u53CA\u91D1\u984D\u3002";
    const openingItems = store.reconcileInvoiceDraft.filter((x) => x.origin === "opening");
    if (!error && openingItems.length) {
      const account = store.accounts.find((a) => a.name === store.reconciliationContext.accountName), entry = openingEntry(selectedFiscalYear(), account.name), expected = store.reconciliationContext.kind === "AR" ? entry.debit : entry.credit, total = openingItems.reduce((s, x) => s + x.amount, 0);
      if (total !== expected) error = `\u671F\u521D\u767C\u7968\u5408\u8A08 ${fmt(total)} \u5FC5\u9808\u7B49\u65BC\u671F\u521D\u6578 ${fmt(expected)}\u3002`;
    }
    const message = document.getElementById("reconcileMessage");
    message.textContent = error;
    message.className = "form-message";
    return !error;
  }
  function saveReconcileRecords() {
    var _a, _b;
    if (!store.reconciliationContext || !validateReconcileDraft()) return false;
    const { kind, accountName, party, month, openingWasDisplayed } = store.reconciliationContext, source = kind === "AR" ? store.salesInvoices : store.purchaseInvoices, matchPeriod = (date) => month === null ? dateInFiscalYear2(date) : String(date).slice(0, 7) === month.key;
    for (let i = source.length - 1; i >= 0; i--) if (matchPeriod(source[i][0]) && normalParty(source[i][2]) === normalParty(party)) source.splice(i, 1);
    store.reconcileInvoiceDraft.filter((x) => x.origin !== "opening").forEach((x) => source.push([x.date, x.invoiceNo, party, x.amount]));
    source.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const openingItems = store.reconcileInvoiceDraft.filter((x) => x.origin === "opening");
    if (openingWasDisplayed) {
      (_a = store.openingInvoiceDetails)[_b = store.selectedFiscalKey] ?? (_a[_b] = {});
      if (openingItems.length) store.openingInvoiceDetails[store.selectedFiscalKey][accountName] = openingItems.map((x) => ({ date: x.date, invoiceNo: x.invoiceNo, amount: x.amount }));
      else delete store.openingInvoiceDetails[store.selectedFiscalKey][accountName];
    }
    for (let i = store.allocations.length - 1; i >= 0; i--) if (store.allocations[i].kind === kind && normalParty(store.allocations[i].party) === normalParty(party) && matchPeriod(store.allocations[i].date)) store.allocations.splice(i, 1);
    for (let i = store.allocationReview.length - 1; i >= 0; i--) if (store.allocationReview[i].kind === kind && normalParty(store.allocationReview[i].party) === normalParty(party)) store.allocationReview.splice(i, 1);
    store.reconcilePaymentDraft.forEach((x) => store.allocations.push({ kind, party, invoiceNo: x.invoiceNo, date: x.date, amount: x.amount, voucher: x.voucher, source: x.source || "\u4EBA\u5DE5\u8A18\u9304", manual: true }));
    delete store.reconciliationConfirmations[reconcileKey(kind, party, month)];
    renderInvoiceNumberList();
    renderReport();
    document.getElementById("reconcileMessage").textContent = "\u2713 \u4FEE\u6539\u5DF2\u5132\u5B58\uFF0C\u5DEE\u984D\u53CA\u72C0\u614B\u5DF2\u66F4\u65B0\u3002";
    document.getElementById("reconcileMessage").className = "form-message success";
    return true;
  }
  function closeReconciliation() {
    document.getElementById("reconcileModal").hidden = true;
    store.reconciliationContext = null;
    store.reconcileInvoiceDraft = [];
    store.reconcilePaymentDraft = [];
  }
  function reportBody() {
    if (store.report === "trial") {
      const selected = selectedFiscalMonth(), fy = selectedFiscalYear(), factor = 1, active = fiscalAccounts(fy), dr = active.reduce((s, a) => s + Math.max(0, accountSignedBalance(a)), 0), cr = active.reduce((s, a) => s + Math.max(0, -accountSignedBalance(a)), 0), heading = selected ? `Trial Balance as at ${selected.end}` : `Trial Balance as at 31 Mar ${fy.start + 1}`;
      return `${monthSelector()}<div class="excel-sheet">${sheetHeading(heading)}<div class="table-card"><table><thead><tr><th>Account</th><th class="num">Dr</th><th class="num">Cr</th></tr></thead><tbody>${tbRows(factor)}<tr class="total"><td data-label="Account">Total</td><td class="num" data-label="Dr">${fmt(dr)}</td><td class="num" data-label="Cr">${fmt(cr)}</td></tr></tbody></table></div></div>`;
    }
    if (store.report === "pl") {
      const selected = selectedFiscalMonth(), incomeCore = ["Sales", "Bank Interest", "Sundry Income"], expenseCore = ["Advertising Fee", "Rent", "Bank Charges", "Toys Membership Fee", "Sundry Expenses", "Business Trip", "Discount allowance", "Salary and allowance", "I Cloud fee", "Booth Fee", "Printing and Stationary", "Insurance", "Business Registration", "Transportation Fee", "Entertainment", "Website Fee", "Secretary Fee", "Courier Fee", "Copy Right", "MPF"], costCore = ["Opening Stock", "Purchases", "Closing Stock Adjustment"], customIncome = store.accounts.filter((a) => a.custom && a.type === "\u6536\u5165" && !incomeCore.includes(a.name) && !incomeCore.includes(a.originalName || "") && accountHasFiscalActivity(a)).map((a) => [a.name, customAccountAmount(a, false)]), customExpenses = store.accounts.filter((a) => a.custom && a.type === "\u8CBB\u7528" && !expenseCore.includes(a.name) && !expenseCore.includes(a.originalName || "") && accountHasFiscalActivity(a)).map((a) => [a.name, customAccountAmount(a, false)]), customCosts = store.accounts.filter((a) => a.custom && a.type === "\u6210\u672C" && !costCore.includes(a.name) && !costCore.includes(a.originalName || "") && accountHasFiscalActivity(a)).map((a) => [a.name, customAccountAmount(a, false)]), expenses = [["Advertising Fee", "Advertising Fee", 77887.8], ["Rent", "Rent", 137500], ["Bank Charges", "Bank Charges", 2502.53], ["Toys Membership Fee", "Toys Membership Fee", 9666.7], ["Sundry Expenses", "Sundry Expenses", 22692.96], ["Business Trip", "Business Trip", 56304.34], ["Discount allowance", "Discount allowance", 1104], ["Salary", "Salary and allowance", 686e3], ["I Cloud fee", "I Cloud fee", 4803.25], ["Booth Fee", "Booth Fee", 96640], ["Printing", "Printing and Stationary", 5187], ["Insurance", "Insurance", 4500], ["Business Registration", "Business Registration", 2150], ["Transportation Fee", "Transportation Fee", 10590.2], ["Entertainment", "Entertainment", 5662], ["Website Fee", "Website Fee", 1016], ["Secretary Fee", "Secretary Fee", 1650], ["Courier Fee", "Courier Fee", 12646.26], ["Copy Right", "Copy Right", 80943.12], ["MPF", "MPF", 12750]].filter((r) => {
        const a = store.accounts.find((x) => x.name === r[1] || x.originalName === r[1]);
        return a && accountHasFiscalActivity(a);
      }).map((r) => [r[0], profitLossAccountAmount(r[1], dollarsToCents(r[2]), ["\u8CBB\u7528"])]).concat(customExpenses);
      const stockAmounts = selected ? monthlyStockAmounts(selected) : null, customIncomeTotal = customIncome.reduce((s, r) => s + r[1], 0), customCostTotal = customCosts.reduce((s, r) => s + r[1], 0), sales = profitLossAccountAmount("Sales"), openingStock = selected ? stockAmounts.opening : profitLossAccountAmount("Opening Stock"), purchases = profitLossAccountAmount("Purchases"), closingStock = selected ? stockAmounts.closing : profitLossAccountAmount("Closing Stock Adjustment"), bankInterest = profitLossAccountAmount("Bank Interest"), sundryIncome = profitLossAccountAmount("Sundry Income"), totalExpenses = expenses.reduce((s, r) => s + r[1], 0), costOfSales = openingStock + purchases + customCostTotal - closingStock, otherRevenue = bankInterest + sundryIncome + customIncomeTotal, gross = sales - costOfSales + otherRevenue, net = gross - totalExpenses, heading = selected ? `Profit and Loss account for ${selected.long}` : `Profit and Loss account for the year ended 31 Mar ${selectedFiscalYear().start + 1}`, stockLabel = selected ? `Less: Closing stock as at ${selected.end}` : `Less: Closing stock as at 31 Mar ${selectedFiscalYear().start + 1}`;
      return `${monthSelector()}<div class="excel-sheet">${sheetHeading(heading)}<div class="excel-statement">${pLine("Revenue Accounts", null, null, "section")}${pLine("Sales", null, sales)}${pLine("Less Cost of Sales", null, null, "section")}${pLine("Opening Stock", openingStock, null, "indent")}${pLine("Add: Purchases", purchases, null, "indent")}${customCosts.map((r) => pLine(r[0], r[1], null, "indent")).join("")}${pLine(stockLabel, closingStock, costOfSales, "indent subtotal")}${pLine("", null, sales - costOfSales, "subtotal")}${pLine("Other Revenue", null, null, "section")}${pLine("Bank Interest", bankInterest, null, "indent")}${pLine("Sundry Income", sundryIncome, null, "indent")}${customIncome.map((r) => pLine(r[0], r[1], null, "indent")).join("")}${pLine("Total Other Revenue", null, otherRevenue, "indent subtotal")}${pLine("Gross profit/loss", null, gross, "total")}${pLine("Less Expenses", null, null, "section")}${expenses.map((r) => pLine(r[0], r[1], null, "indent")).join("")}${pLine("Total expenses", null, totalExpenses, "subtotal")}${pLine(net >= 0 ? "Net Profit" : "Net Loss", null, net, "total")}</div></div>`;
    }
    if (store.report === "bs") {
      const selected = selectedFiscalMonth(), factor = 1, scale = (v) => v, heading = selected ? `Balance Sheet as at ${selected.end}` : `Balance Sheet as at 31 Mar ${selectedFiscalYear().start + 1}`, assetCore = ["Prototype", "Moulds", "Furniture and Equipment", "Accumulated Depreciation", "Bank Saving Account", "Bank Current Account", "Closing Stock"], liabilityCore = ["Accounts Payable of Wingo Creative Co Ltd", "Current Account of Lam Hon Fai", "Temporary Receivable", "Loan of Hong Kong Enterprise Association Limited", "Loan of Hong Kong Safety Service Ltd", "Loan of Hong Kong Fiduciary Association Ltd", "Accrued Expenses"], customAssets = store.accounts.filter((a) => a.custom && a.type === "\u8CC7\u7522" && !assetCore.includes(a.name) && !a.name.startsWith("Accounts Receivable of ") && accountHasFiscalActivity(a)).map((a) => [a.name, customAccountAmount(a, true)]), customLiabilities = store.accounts.filter((a) => a.custom && a.type === "\u8CA0\u50B5" && !liabilityCore.includes(a.name) && accountHasFiscalActivity(a)).map((a) => [a.name, customAccountAmount(a, true)]), customEquity = store.accounts.filter((a) => a.custom && a.type === "\u6B0A\u76CA" && a.name !== "Capital of Lam Hon Fai" && accountHasFiscalActivity(a)).map((a) => [a.name, customAccountAmount(a, true)]), receivables = store.accounts.filter((a) => a.type === "\u8CC7\u7522" && a.name.startsWith("Accounts Receivable of ") && accountHasFiscalActivity(a)).map((a) => [a.name, scale(accountBalance(a))]);
      const liabilities = liabilityCore.map((name) => [name, scale(accountValue(name, 0, ["\u8CA0\u50B5"]))]).filter((r) => r[1] !== 0), prototype = scale(accountValue("Prototype", 0, ["\u8CC7\u7522"])), moulds = scale(accountValue("Moulds", dollarsToCents(57e3), ["\u8CC7\u7522"])), furniture = scale(accountValue("Furniture and Equipment", dollarsToCents(22881), ["\u8CC7\u7522"])), accumulated = scale(accountValue("Accumulated Depreciation", dollarsToCents(15976.2), ["\u8CC7\u7522"])), fixedTotal = prototype + moulds + furniture - accumulated, bankSaving = scale(accountValue("Bank Saving Account", dollarsToCents(10420.29), ["\u8CC7\u7522"])), bankCurrent = scale(accountValue("Bank Current Account", dollarsToCents(1804.9), ["\u8CC7\u7522"])), stock = scale(accountValue("Closing Stock", dollarsToCents(555138.41), ["\u8CC7\u7522"])), receivableTotal = receivables.reduce((s, r) => s + r[1], 0), customAssetTotal = customAssets.reduce((s, r) => s + r[1], 0), currentAssetTotal = bankSaving + bankCurrent + receivableTotal + stock + customAssetTotal, totalAssets = fixedTotal + currentAssetTotal, capital = scale(accountValue("Capital of Lam Hon Fai", dollarsToCents(100), ["\u6B0A\u76CA"])), plAccount = store.accounts.find((account) => account.code === "3100") || findAccountByName("Profit and Loss account"), plOpening = plAccount ? openingEntry(selectedFiscalYear(), plAccount.name) : null, plHasOpening = plOpening && (plOpening.debit !== 0 || plOpening.credit !== 0), plCarried = plAccount ? plHasOpening ? plOpening.credit - plOpening.debit : selectedFiscalYear().start === 2023 && !store.deletedDataYears.has("2023") ? -accountSignedBalance(plAccount) : 0 : 0, currentResult = currentYearProfitLoss(), customEquityTotal = customEquity.filter((r) => !plAccount || r[0] !== plAccount.name).reduce((s, r) => s + r[1], 0), liabilityTotal = liabilities.reduce((s, r) => s + r[1], 0) + customLiabilities.reduce((s, r) => s + r[1], 0), equityTotal = capital + customEquityTotal + plCarried + currentResult;
      return `${monthSelector()}<div class="excel-sheet">${sheetHeading(heading)}<div class="balance-sheet"><div class="balance-side">${bLine("Fixed Asset", null, null, "section")}${bLine("Prototype", prototype, null)}${bLine("Moulds", moulds, null)}${bLine("Furniture and Equipment", furniture, null)}${bLine("Less: Accumulated Depreciation", accumulated, null)}${bLine("Total Fixed Asset", null, fixedTotal, "subtotal")}${bLine("Current Asset", null, null, "section")}${bLine("Bank S/A", bankSaving, null)}${bLine("Bank C/A", bankCurrent, null)}${receivables.map((r) => bLine(r[0], r[1], null)).join("")}${bLine(`Closing stock as at ${selected ? selected.end : "31 Mar " + (selectedFiscalYear().start + 1)}`, stock, null)}${customAssets.length ? bLine("\u65B0\u589E\u8CC7\u7522\u79D1\u76EE", null, null, "section") + customAssets.map((r) => bLine(r[0], r[1], null)).join("") : ""}${bLine("Total Current Asset", null, currentAssetTotal, "subtotal")}${bLine("Total Assets", null, totalAssets, "grand")}</div><div class="balance-side">${bLine("Capital", null, null, "section")}${bLine("Capital of Lam Hon Fai", capital, null)}${customEquity.filter((r) => !plAccount || r[0] !== plAccount.name).map((r) => bLine(r[0], r[1], null)).join("")}${bLine("Total Capital", null, capital + customEquityTotal, "subtotal")}${bLine("Profit and Loss account", null, null, "section")}${bLine(`Balance at 31 Mar ${selectedFiscalYear().start}`, plCarried, null)}${bLine(currentResult >= 0 ? "Add: Net Profit" : "Less: Net Loss", Math.abs(currentResult), plCarried + currentResult)}${bLine("Current Liabilities", null, null, "section")}${liabilities.map((r) => bLine(r[0], r[1], null)).join("")}${customLiabilities.map((r) => bLine(r[0], r[1], null)).join("")}${bLine("Total Current Liabilities", null, liabilityTotal, "subtotal")}${bLine("Total Capital and Liabilities", null, liabilityTotal + equityTotal, "grand")}</div></div></div>`;
    }
    if (store.report === "ar" || store.report === "ap") {
      const isAR = store.report === "ar", kind = isAR ? "AR" : "AP", selected = selectedFiscalMonth(), invoicePeriod = (r) => r[4] === "opening" ? !selected || r[0].slice(0, 7) === selected.key : dateInFiscalYear2(r[0]) && (!selected || r[0].slice(0, 7) === selected.key), listAll = (isAR ? store.accounts.filter((a) => a.name.startsWith("Accounts Receivable of")) : store.accounts.filter((a) => a.name.startsWith("Accounts Payable of"))).filter((a) => accountHasFiscalActivity(a)), list = selected ? listAll.filter((a) => invoiceMatches(kind, a.name.replace(/^Accounts (Receivable|Payable) of /, "")).some(invoicePeriod) || partyVoucherPayments(kind, a.name).some((x) => x.date.slice(0, 7) === selected.key)) : listAll, accountTotal = list.reduce((s, a) => s + accountSignedBalance(a), 0);
      let invoiceTotal = 0, pendingCount = 0;
      const rows = list.map((a, i) => {
        const party = a.name.replace(/^Accounts (Receivable|Payable) of /, ""), openingStatus = openingInvoiceStatus(a.name), matches = invoiceMatches(kind, party).filter(invoicePeriod), voucherPayments = partyVoucherPayments(kind, a.name).filter((x) => !selected || x.date.slice(0, 7) === selected.key);
        let calculated = 0;
        const details = matches.length ? matches.map((r) => {
          const payments = store.allocations.filter((x) => x.kind === kind && x.invoiceNo === r[1] && dateInFiscalYear2(x.date)), paid = payments.reduce((s, x) => s + x.amount, 0), balance = Math.max(0, r[3] - paid);
          calculated = calculated + balance;
          const history = payments.length ? `<div class="payment-history">${payments.map((p) => `<div class="payment-row"><span>${esc(p.date)}</span><span>${esc(p.voucher)} \xB7 ${esc(p.source)} \xB7 \u5C0D\u92B7 ${esc(p.invoiceNo)}</span><span class="num">${isAR ? "\u6536\u6B3E" : "\u4ED8\u6B3E"} ${fmt(p.amount)}</span></div>`).join("")}</div>` : "";
          return `<div class="invoice-record"><div class="invoice-item"><span>${r[0]}</span><span>${esc(r[1] || "\u2014")}</span><span>${invoiceVoucherRefs(kind, r[1], r[4], r[5])}</span><span class="num">${fmt(r[3])}</span><span class="num">${fmt(paid)}</span><span class="num">${fmt(balance)}</span></div>${history}</div>`;
        }).join("") : `<div class="empty">\u4F86\u6E90\u5831\u8868\u672A\u6709\u76F8\u7B26\u767C\u7968</div>`;
        invoiceTotal += calculated;
        const signedBalance = accountSignedBalance(a), partyReview = store.allocationReview.some((x) => x.kind === kind && normalParty(x.party) === normalParty(party)), state = currentReconcileState(kind, party, calculated, signedBalance), needsReview = openingStatus.state === "pending" || !state.matched || partyReview;
        if (needsReview && !state.confirmed) pendingCount++;
        let statusHTML = "";
        if (state.matched && !partyReview) statusHTML = '<span class="status-tag">\u5DF2\u5C0D\u4E0A</span>';
        else if (state.confirmed) statusHTML = `<span class="status-tag">\u5DF2\u6838\u5C0D</span><small class="reconcile-meta">${esc(state.saved.confirmedBy)} \xB7 ${esc(state.saved.date)}</small>`;
        else statusHTML = `<div class="reconcile-actions"><span class="review-tag">\u5F85\u6838\u5C0D</span><button class="btn open-reconcile" type="button" data-kind="${kind}" data-account="${esc(a.name)}" data-party="${esc(party)}">\u6A19\u8A18\u5DF2\u6838\u5C0D</button></div>`;
        const voucherHistory = voucherPayments.length ? `<div class="account-payment-list"><h4>${isAR ? "\u6536\u6B3E" : "\u4ED8\u6B3E"} Voucher \u8A18\u9304</h4>${voucherPayments.map((p) => `<div class="account-payment-row"><span>${esc(p.date)}</span><b>${esc(p.voucher)}</b><span class="num">${isAR ? "\u6536\u6B3E" : "\u4ED8\u6B3E"} ${fmt(p.amount)}</span><span>${p.invoices.length ? "\u5C0D\u92B7 " + p.invoices.map(esc).join("\u3001") : p.specified ? "\u6307\u5B9A " + esc(p.specified) + "\uFF08\u5F85\u6838\u5C0D\uFF09" : "\u672A\u80FD\u5C0D\u92B7\u767C\u7968\uFF0F\u5F85\u6838\u5C0D"}</span></div>`).join("")}</div>` : `<div class="account-payment-list"><h4>${isAR ? "\u6536\u6B3E" : "\u4ED8\u6B3E"} Voucher \u8A18\u9304</h4><div class="empty">\u672A\u6709${isAR ? "\u6536\u6B3E" : "\u4ED8\u6B3E"} voucher</div></div>`;
        return `<tr><td data-label="${isAR ? "\u5BA2\u6236" : "\u4F9B\u61C9\u5546"}"><button class="drill-trigger" data-detail="aging-${i}" aria-expanded="false"><span class="drill-chevron">\u203A</span>${esc(party)}</button></td><td class="num" data-label="\u767C\u7968\u7D50\u6B20">${fmt(calculated)}</td><td class="num" data-label="\u8CEC\u6236\u7D50\u9918">${signedFmt(signedBalance)}</td><td data-label="\u72C0\u614B">${openingProgressHTML(openingStatus)}${statusHTML}</td></tr><tr class="detail-row" id="aging-${i}" hidden><td colspan="4">${openingProgressHTML(openingStatus, true)}<p class="invoice-note">${openingStatus.state === "pending" ? "\u671F\u521D\u767C\u7968\u660E\u7D30\u5F85\u5B8C\u6210\uFF1B\u6536\uFF0F\u4ED8\u6B3E\u66AB\u6309\u7E3D\u984D\u8655\u7406\uFF0C\u5B8C\u6210\u5F8C\u624D\u9032\u884C\u9010\u5F35\u767C\u7968 FIFO \u5C0D\u92B7\u3002" : "\u767C\u7968\u53CA\u6BCF\u7B46\u6536\uFF0F\u4ED8\u6B3E voucher \u5206\u958B\u5217\u51FA\uFF1B\u6709\u6307\u5B9A\u767C\u7968\u865F\u5C31\u5C0D\u92B7\u8A72\u5F35\uFF0C\u7559\u7A7A\u5247\u6309\u65E5\u671F FIFO\u3002"}</p><div class="invoice-list"><div class="invoice-item head"><span>\u767C\u7968\u65E5\u671F</span><span>\u767C\u7968\u865F</span><span>Voucher Number</span><span>\u767C\u7968\u91D1\u984D</span><span>${isAR ? "\u5DF2\u6536\u91D1\u984D" : "\u5DF2\u4ED8\u91D1\u984D"}</span><span>\u7D50\u6B20\u91D1\u984D</span></div>${details}</div>${voucherHistory}<div class="reconcile-actions" style="margin-top:12px"><button class="btn edit-reconcile" type="button" data-kind="${kind}" data-account="${esc(a.name)}" data-party="${esc(party)}">\u4EBA\u5DE5\u4FEE\u6539\u767C\u7968\uFF0F${isAR ? "\u6536\u6B3E" : "\u4ED8\u6B3E"}\u8A18\u9304</button>${state.confirmed ? `<small class="muted">\u6838\u5C0D\u5099\u8A3B\uFF1A${esc(state.saved.note || "\u2014")}</small>` : ""}</div></td></tr>`;
      }).join("");
      return `${monthSelector()}<div class="aging"><div><small>\u8CEC\u6236\u7D50\u9918</small><b>HK$ ${signedFmt(accountTotal)}</b></div><div><small>\u767C\u7968\u8A08\u7B97\u7D50\u6B20</small><b>${money(invoiceTotal)}</b></div><div><small>\u5F85\u6838\u5C0D\u516C\u53F8</small><b>${pendingCount}</b></div><div><small>\u6307\u5B9A\u767C\u7968\u898F\u5247</small><b>\u512A\u5148</b></div><div><small>\u672A\u6307\u5B9A\u898F\u5247</small><b>FIFO</b></div></div><div class="callout" style="margin-bottom:14px"><strong>\u5C0D\u92B7\u898F\u5247\uFF1A</strong>\u6708\u4EFD\u6309\u767C\u7968\u53CA voucher \u65E5\u671F\u7BE9\u9078\uFF1Bvoucher \u6709\u767C\u7968\u865F\u5C31\u5C0D\u6307\u5B9A\u767C\u7968\uFF0C\u672A\u586B\u5C31\u7531\u6700\u820A\u767C\u7968\u958B\u59CB\uFF1B\u5982\u671F\u521D\u767C\u7968\u660E\u7D30\u4ECD\u662F\u300C\u5F85\u5B8C\u6210\u300D\uFF0C\u8A72\u79D1\u76EE\u6536\uFF0F\u4ED8\u6B3E\u66AB\u6309\u7E3D\u984D\u8655\u7406\uFF0C\u4E0D\u505A\u9010\u5F35\u767C\u7968\u5C0D\u92B7\u3002\u8CB8\u65B9\u7D50\u9918\u4EE5\u8CA0\u6578\u986F\u793A\u3002\u5F85\u6838\u5C0D\u9805\u76EE\u53EF\u8A18\u9304\u78BA\u8A8D\u4EBA\u3001\u65E5\u671F\u53CA\u5099\u8A3B\uFF0C\u4EA6\u53EF\u76F4\u63A5\u88DC\u52A0\u3001\u4FEE\u6539\u6216\u522A\u9664\u767C\u7968\u53CA\u6536\uFF0F\u4ED8\u6B3E\u8A18\u9304\u3002</div>${rows ? `<div class="table-card"><table><thead><tr><th>${isAR ? "\u5BA2\u6236 Customer" : "\u4F9B\u61C9\u5546 Supplier"}</th><th class="num">\u767C\u7968\u7D50\u6B20</th><th class="num">\u8CEC\u6236\u7D50\u9918</th><th>\u72C0\u614B\uFF0F\u52D5\u4F5C</th></tr></thead><tbody>${rows}<tr class="total"><td data-label="\u7E3D\u8A08">\u7E3D\u8A08</td><td class="num" data-label="\u767C\u7968\u7D50\u6B20">${fmt(invoiceTotal)}</td><td class="num" data-label="\u8CEC\u6236\u7D50\u9918">${signedFmt(accountTotal)}</td><td data-label="\u72C0\u614B">${pendingCount ? '<span class="review-tag">\u5F85\u6838\u5C0D</span>' : '<span class="status-tag">\u5DF2\u6838\u5C0D\uFF0F\u5DF2\u5C0D\u4E0A</span>'}</td></tr></tbody></table></div>` : '<div class="empty">\u6240\u9078\u6708\u4EFD\u672A\u6709\u671F\u521D\u6578\u3001\u904E\u8CEC\u6216\u76F8\u7B26\u767C\u7968</div>'}`;
    }
    if (store.report === "journal") {
      const journalRows = store.vouchers.map((v, voucherIndex) => ({ v, voucherIndex })).filter(({ v }) => dateInFiscalYear2(v.date) && (store.reportState.month === null || v.date.slice(0, 7) === store.reportState.month.key)).flatMap(({ v, voucherIndex }) => v.lines.map((line, lineIndex) => ({ date: v.date, no: v.no, account: line.account, particulars: line.detail || v.desc, debit: line.debit, credit: line.credit, lineIndex, voucherIndex }))).sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no) || a.lineIndex - b.lineIndex);
      const debitTotal = journalRows.reduce((sum, row) => sum + row.debit, 0), creditTotal = journalRows.reduce((sum, row) => sum + row.credit, 0);
      return `${monthSelector()}<div class="table-card"><table><thead><tr><th>Date</th><th>Voucher No.</th><th>Account</th><th>Particulars</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${journalRows.map((row) => `<tr><td data-label="Date">${esc(row.date)}</td><td data-label="Voucher No."><b>${esc(row.no)}</b>${attachmentButtonHTML(row.voucherIndex)}</td><td data-label="Account">${esc(row.account)}</td><td data-label="Particulars">${esc(row.particulars || "\u2014")}</td><td class="num" data-label="Debit">${row.debit ? fmt(row.debit) : "\u2014"}</td><td class="num" data-label="Credit">${row.credit ? fmt(row.credit) : "\u2014"}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">\u6240\u9078\u671F\u9593\u672A\u6709 Journal \u5206\u9304</td></tr>'}${journalRows.length ? `<tr class="total"><td data-label="Date"></td><td data-label="Voucher No."></td><td data-label="Account"></td><td data-label="Particulars">Total</td><td class="num" data-label="Debit">${fmt(debitTotal)}</td><td class="num" data-label="Credit">${fmt(creditTotal)}</td></tr>` : ""}</tbody></table></div>`;
    }
    if (store.report === "purchase" || store.report === "sales") {
      const isPurchase = store.report === "purchase", data = reportTransactionRows(isPurchase), nameQ = store.reportState.nameQuery.toLowerCase(), invoiceQ = store.reportState.invoiceQuery.toLowerCase();
      const filtered = data.filter((r) => (store.reportState.month === null || r.date.slice(0, 7) === store.reportState.month.key) && (!nameQ || String(r.name).toLowerCase().includes(nameQ)) && (!invoiceQ || String(r.invoice).toLowerCase().includes(invoiceQ)));
      const months = fiscalMonths(), chartBase = data.filter((r) => (!nameQ || String(r.name).toLowerCase().includes(nameQ)) && (!invoiceQ || String(r.invoice).toLowerCase().includes(invoiceQ))), totals = months.map((m) => chartBase.filter((r) => r.date.slice(0, 7) === m.key).reduce((sum, row) => sum + row.amount, 0)), channelTotals = months.map((m) => {
        const rows = chartBase.filter((r) => r.date.slice(0, 7) === m.key);
        return salesChannels.map((c) => rows.filter((r) => salesChannel(r) === c.key).reduce((sum, row) => sum + row.amount, 0));
      }), max = isPurchase ? Math.max(...totals, 1) : Math.max(...channelTotals.flat(), 1);
      const chart = isPurchase ? `<div class="monthly-chart" aria-label="\u6BCF\u6708\u7E3D\u984D\u67F1\u72C0\u5716">${totals.map((v, i) => `<div class="chart-col ${store.reportState.month?.key === months[i].key ? "selected" : ""}" title="${months[i].long}\uFF1AHK$ ${fmt(v)}"><div class="chart-bar-wrap"><div class="chart-bar" style="height:${Math.max(2, v / max * 100)}%"></div></div><small>${months[i].short.replace(" 20", " ")}</small></div>`).join("")}</div>` : `<div class="channel-legend"><span><i></i>AR \u8CD2\u92B7</span><span><i></i>Online Sales</span><span><i></i>PMQ \u9580\u5E02</span></div><div class="monthly-chart" aria-label="\u6BCF\u6708\u6309\u92B7\u552E\u6E20\u9053\u67F1\u72C0\u5716">${channelTotals.map((values, i) => `<div class="chart-col ${store.reportState.month?.key === months[i].key ? "selected" : ""}" title="${months[i].long}\uFF1AAR ${fmt(values[0])}\uFF1BOnline ${fmt(values[1])}\uFF1BPMQ ${fmt(values[2])}"><div class="chart-bar-group">${values.map((v, j) => `<div class="channel-bar ${j === 1 ? "online" : j === 2 ? "pmq" : ""}" style="height:${Math.max(2, v / max * 100)}%"></div>`).join("")}</div><small>${months[i].short.replace(" 20", " ")}</small></div>`).join("")}</div>`;
      const order = store.reportState.month === null ? months.map((m) => m.key) : [store.reportState.month.key];
      const rowHTML = (r) => `<tr><td data-label="Date">${r.date}</td><td data-label="Invoice number">${esc(r.invoice || "\u2014")}</td><td data-label="Voucher Number">${r.voucherHtml}</td><td data-label="Name">${esc(r.name)}</td><td class="num" data-label="Amount">${fmt(r.amount)}</td><td data-label="Remark">${esc(r.remark)}</td></tr>`;
      const blocks = order.map((key) => {
        const monthRows = filtered.filter((r) => r.date.slice(0, 7) === key), period = months.find((m) => m.key === key);
        if (!monthRows.length) return "";
        const monthTotal = monthRows.reduce((sum, row) => sum + row.amount, 0);
        if (isPurchase) return `<section class="month-block">${sheetHeading(`Purchases Report of ${period.long}`)}<div class="table-card"><table><thead><tr><th>Date</th><th>Invoice number</th><th>Voucher Number</th><th>Name</th><th class="num">Amount</th><th>Remark</th></tr></thead><tbody>${monthRows.map(rowHTML).join("")}<tr class="month-total"><td data-label="Date"></td><td data-label="Invoice number"></td><td data-label="Voucher Number"></td><td data-label="Name">Total</td><td class="num" data-label="Amount">${fmt(monthTotal)}</td><td data-label="Remark"></td></tr></tbody></table></div></section>`;
        const channelSections = salesChannels.map((channel) => {
          const channelRows = monthRows.filter((r) => salesChannel(r) === channel.key), channelTotal = channelRows.reduce((sum, row) => sum + row.amount, 0);
          let body = "";
          if (channel.key === "ar") {
            const parties = [...new Set(channelRows.map((r) => r.name))].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
            body = parties.map((party) => {
              const partyRows = channelRows.filter((r) => r.name === party), partyTotal = partyRows.reduce((sum, row) => sum + row.amount, 0);
              return partyRows.map(rowHTML).join("") + `<tr class="party-subtotal"><td data-label="Date"></td><td data-label="Invoice number"></td><td data-label="Voucher Number"></td><td data-label="Name">${esc(party)} \u5C0F\u8A08</td><td class="num" data-label="Amount">${fmt(partyTotal)}</td><td data-label="Remark"></td></tr>`;
            }).join("");
          } else body = channelRows.map(rowHTML).join("");
          return `<section class="channel-section"><h4><span>${channel.label}</span><span class="money">HK$ ${fmt(channelTotal)}</span></h4><div class="table-card"><table><thead><tr><th>Date</th><th>Invoice number</th><th>Voucher Number</th><th>Name</th><th class="num">Amount</th><th>Remark</th></tr></thead><tbody>${body || '<tr><td colspan="6" class="empty">\u672C\u6708\u672A\u6709\u6B64\u6E20\u9053\u92B7\u552E</td></tr>'}<tr class="month-total"><td data-label="Date"></td><td data-label="Invoice number"></td><td data-label="Voucher Number"></td><td data-label="Name">${channel.label} \u5C0F\u8A08</td><td class="num" data-label="Amount">${fmt(channelTotal)}</td><td data-label="Remark"></td></tr></tbody></table></div></section>`;
        }).join("");
        return `<section class="month-block">${sheetHeading(`Sales Report ${period.long}`)}${channelSections}<div class="callout" style="margin-top:12px"><strong>${period.long} \u7E3D\u8A08\uFF1A</strong><span class="money">HK$ ${fmt(monthTotal)}</span></div></section>`;
      }).join("");
      const grandTotal = filtered.reduce((sum, row) => sum + row.amount, 0), rules = isPurchase ? "" : `<div class="callout channel-rule"><strong>\u6E20\u9053\u5206\u985E\u898F\u5247\uFF1A</strong>\u5BA2\u6236\u540D\u6709\u5C0D\u61C9 Accounts Receivable \u8CEC\u6236\u6B78\u5165\u300CAR \u8CD2\u92B7\u300D\uFF1B\u5BA2\u6236\u540D\u5305\u542B PMQ \u6B78\u5165\u300CPMQ \u9580\u5E02\u300D\uFF1B\u5176\u9918\u76F4\u63A5\u92B7\u552E\uFF08\u5305\u62EC\u6C92\u6709\u5BA2\u6236\u540D\u800C\u76F4\u63A5\u8CB8\u8A18 Sales \u7684 Bank Voucher\uFF09\u6B78\u5165\u300COnline Sales\u300D\u3002</div>`;
      return `${monthSelector()}${rules}<div class="report-filters" style="margin-bottom:18px"><input id="reportNameFilter" value="${esc(store.reportState.nameQuery)}" placeholder="\u641C\u5C0B${isPurchase ? "\u4F9B\u61C9\u5546" : "\u5BA2\u6236"}\u540D\u7A31" aria-label="\u641C\u5C0B${isPurchase ? "\u4F9B\u61C9\u5546" : "\u5BA2\u6236"}\u540D\u7A31"><input id="reportInvoiceFilter" value="${esc(store.reportState.invoiceQuery)}" placeholder="\u641C\u5C0B\u767C\u7968\u865F\u78BC" aria-label="\u641C\u5C0B\u767C\u7968\u865F\u78BC"></div>${chart}${blocks || '<div class="empty">\u6C92\u6709\u7B26\u5408\u7BE9\u9078\u689D\u4EF6\u7684\u767C\u7968\u6216 Voucher \u5206\u9304</div>'}${!isPurchase && blocks ? `<div class="statement-row total"><span>\u5168\u4EFD\u92B7\u552E\u5831\u544A\u7E3D\u8A08</span><span class="money">HK$ ${fmt(grandTotal)}</span></div>` : ""}`;
    }
    return `${monthSelector()}<div class="table-card"><table><thead><tr><th>\u65E5\u671F</th><th>Voucher</th><th>\u985E\u578B</th><th>\u6458\u8981</th><th class="num">\u91D1\u984D</th><th>\u88FD\u8868\uFF0F\u8986\u6838\uFF0F\u6279\u6838</th><th>\u72C0\u614B</th></tr></thead><tbody>${store.vouchers.map((v, voucherIndex) => ({ v, voucherIndex })).filter(({ v }) => dateInFiscalYear2(v.date) && (store.reportState.month === null || v.date.slice(0, 7) === store.reportState.month.key)).map(({ v, voucherIndex }) => `<tr><td data-label="\u65E5\u671F">${v.date}</td><td data-label="Voucher"><b>${esc(v.no)}</b>${attachmentButtonHTML(voucherIndex)}</td><td data-label="\u985E\u578B">${v.type === "B" ? "Bank" : "Transfer"}</td><td data-label="\u6458\u8981">${esc(v.desc)}</td><td class="num" data-label="\u91D1\u984D">${fmt(v.lines.reduce((s, l) => s + l.debit, 0))}</td><td data-label="\u88FD\u8868\uFF0F\u8986\u6838\uFF0F\u6279\u6838">${[v.madeBy, v.checkedBy, v.approvedBy].filter(Boolean).map(esc).join(" \uFF0F ") || "\u2014"}</td><td data-label="\u72C0\u614B"><span class="status-tag">\u5DF2\u904E\u8CEC</span></td></tr>`).join("")}</tbody></table></div>`;
  }
  function renderReport() {
    const card = document.getElementById("reportCard");
    card.innerHTML = reportShell(reportBody());
    document.getElementById("exportReport").addEventListener("click", () => exportCSV(false));
    document.getElementById("copyReport").addEventListener("click", () => exportCSV(true));
    bindAttachmentButtons(card);
    card.querySelectorAll(".drill-trigger").forEach((btn) => btn.addEventListener("click", () => {
      const detail = document.getElementById(btn.dataset.detail), open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      detail.hidden = open;
    }));
    card.querySelectorAll(".open-reconcile,.edit-reconcile").forEach((btn) => btn.addEventListener("click", () => openReconciliation(btn.dataset.kind, btn.dataset.account, btn.dataset.party)));
    const monthSelect = document.getElementById("reportMonthSelect");
    if (monthSelect) monthSelect.addEventListener("change", () => {
      store.reportState.month = monthSelect.value ? { key: monthSelect.value } : null;
      store.reportState.date = store.reportState.month ? store.reportState.month.key + "-01" : "";
      renderReport();
    });
    const bindFilter = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        store.reportState[key] = el.value;
        renderReport();
        const next = document.getElementById(id);
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      });
    };
    bindFilter("reportNameFilter", "nameQuery");
    bindFilter("reportInvoiceFilter", "invoiceQuery");
  }
  function exportCSV(copyOnly = false) {
    let rows = [];
    if (store.report === "sales" || store.report === "purchase") {
      const isPurchase = store.report === "purchase", source = reportTransactionRows(isPurchase).filter((r) => (store.reportState.month === null || r.date.slice(0, 7) === store.reportState.month.key) && (!store.reportState.nameQuery || String(r.name).toLowerCase().includes(store.reportState.nameQuery.toLowerCase())) && (!store.reportState.invoiceQuery || String(r.invoice).toLowerCase().includes(store.reportState.invoiceQuery.toLowerCase())));
      rows = isPurchase ? [["Date", "Invoice number", "Voucher Number", "Name", "Amount", "Remark"], ...source.map((r) => [r.date, r.invoice, r.voucherText, r.name, csvDollars(r.amount), r.remark])] : [["Channel", "Date", "Invoice number", "Voucher Number", "Name", "Amount", "Remark"], ...source.sort((a, b) => salesChannels.findIndex((c) => c.key === salesChannel(a)) - salesChannels.findIndex((c) => c.key === salesChannel(b)) || a.name.localeCompare(b.name) || a.date.localeCompare(b.date)).map((r) => [(salesChannels.find((c) => c.key === salesChannel(r)) || {}).label || "", r.date, r.invoice, r.voucherText, r.name, csvDollars(r.amount), r.remark])];
    } else if (store.report === "ar" || store.report === "ap") {
      const kind = store.report === "ar" ? "AR" : "AP", parties = store.accounts.filter((a) => a.name.startsWith(store.report === "ar" ? "Accounts Receivable of " : "Accounts Payable of ")).map((a) => a.name.replace(/^Accounts (Receivable|Payable) of /, "")), seenInv = /* @__PURE__ */ new Set(), source = parties.flatMap((p) => invoiceMatches(kind, p)).filter((r) => {
        const k = r[0] + "|" + String(r[1] || "").trim().toLowerCase();
        if (seenInv.has(k)) return false;
        seenInv.add(k);
        return true;
      });
      rows = [["Date", "Invoice number", "Voucher Number", store.report === "ar" ? "Customer" : "Supplier", "Invoice amount", "Paid", "Outstanding"], ...source.filter((r) => (r[4] === "opening" || dateInFiscalYear2(r[0])) && (store.reportState.month === null || r[0].slice(0, 7) === store.reportState.month.key)).map((r) => {
        const paid = allocatedTotal(kind, r[1]);
        return [r[0], r[1], invoiceVoucherText(kind, r[1], r[4]), r[2], csvDollars(r[3]), csvDollars(paid), csvDollars(Math.max(0, r[3] - paid))];
      })];
    } else if (store.report === "journal") {
      rows = [["Date", "Voucher No.", "Account", "Particulars", "Debit", "Credit"], ...store.vouchers.filter((v) => dateInFiscalYear2(v.date) && (store.reportState.month === null || v.date.slice(0, 7) === store.reportState.month.key)).flatMap((v) => v.lines.map((line, lineIndex) => ({ date: v.date, no: v.no, account: line.account, particulars: line.detail || v.desc, debit: line.debit, credit: line.credit, lineIndex }))).sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no) || a.lineIndex - b.lineIndex).map((row) => [row.date, row.no, row.account, row.particulars, row.debit ? csvDollars(row.debit) : "", row.credit ? csvDollars(row.credit) : ""])];
    } else if (store.report === "register") {
      rows = [["Date", "Voucher", "Type", "Description", "Amount", "Made by", "Checked by", "Approved by"], ...store.vouchers.filter((v) => dateInFiscalYear2(v.date) && (store.reportState.month === null || v.date.slice(0, 7) === store.reportState.month.key)).map((v) => [v.date, v.no, v.type, v.desc, csvDollars(v.lines.reduce((s, l) => s + l.debit, 0)), v.madeBy || "", v.checkedBy || "", v.approvedBy || ""])];
    } else {
      rows = [["Account", "Debit", "Credit"], ...fiscalAccounts().filter((a) => accountSignedBalance(a)).map((a) => {
        const signed = accountSignedBalance(a);
        return [a.name, signed > 0 ? csvDollars(signed) : "", signed < 0 ? csvDollars(Math.abs(signed)) : ""];
      })];
    }
    const csv = "\uFEFF" + rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const period = store.reportState.month === null ? selectedFiscalYear().label : store.reportState.month.key, filename = `Toys-Gallery-${store.report}-${period.replace(/[^A-Za-z0-9-]/g, "-")}.csv`;
    const status = document.getElementById("exportStatus");
    if (copyOnly) {
      if (status) status.textContent = "\u6B63\u5728\u8907\u88FD CSV \u5167\u5BB9\u2026";
      copyTextToClipboard(csv, status);
      return;
    }
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }), opened = openDownloadPopup(blob, filename, "CSV \u4E0B\u8F09");
    if (status) status.textContent = opened ? "\u5DF2\u958B\u65B0\u8996\u7A97\uFF0C\u8ACB\u55BA\u65B0\u8996\u7A97\u64B3\u300C\u64B3\u5462\u5EA6\u4E0B\u8F09\u300D\u5B8C\u6210\u4E0B\u8F09" : "\u700F\u89BD\u5668\u963B\u64CB\u5497\u65B0\u8996\u7A97\uFF0C\u8ACB\u7528\u65C1\u908A\u7684\u300C\u8907\u88FD CSV \u5167\u5BB9\u300D\u63A3";
  }
  function renderKPIs() {
    const salesAccount = findAccountByName("Sales"), purchaseAccount = findAccountByName("Purchases"), salesTotal = salesAccount ? accountBalance(salesAccount) : 0, purchaseTotal = purchaseAccount ? accountBalance(purchaseAccount) : 0, arTotal = store.accounts.filter((a) => a.name.startsWith("Accounts Receivable of ") && accountHasFiscalActivity(a)).reduce((sum, a) => sum + accountSignedBalance(a), 0), apTotal = store.accounts.filter((a) => a.name.startsWith("Accounts Payable of ") && accountHasFiscalActivity(a)).reduce((sum, a) => sum + accountSignedBalance(a), 0), bankTotal = store.accounts.filter((a) => ["Bank Saving Account", "Bank Current Account"].includes(a.name) && accountHasFiscalActivity(a)).reduce((sum, a) => sum + accountSignedBalance(a), 0);
    document.querySelector('[data-kpi="sales"]').textContent = money(salesTotal);
    document.querySelector('[data-kpi="purchases"]').textContent = money(purchaseTotal);
    document.querySelector('[data-kpi="ar"]').textContent = money(arTotal);
    document.querySelector('[data-kpi="ap"]').textContent = money(apTotal);
    document.querySelector('[data-kpi="bank"]').textContent = money(bankTotal);
    const dr = store.accounts.reduce((sum, a) => sum + Math.max(0, accountSignedBalance(a)), 0), cr = store.accounts.reduce((sum, a) => sum + Math.max(0, -accountSignedBalance(a)), 0), diff = dr - cr, balanced = diff === 0, result = currentYearProfitLoss(), status = document.getElementById("reconStatus");
    status.textContent = balanced ? "\u5DF2\u52FE\u7A3D" : "\u672A\u52FE\u7A3D";
    status.style.color = balanced ? "var(--good)" : "var(--bad)";
    document.getElementById("reconDebit").textContent = money(dr);
    document.getElementById("reconCredit").textContent = money(cr);
    const difference = document.getElementById("reconDifference");
    difference.textContent = balanced ? "HK$ 0.00" : money(diff) + " " + (diff > 0 ? "Dr" : "Cr");
    difference.style.color = balanced ? "var(--good)" : "var(--warn)";
    document.getElementById("reconEquation").textContent = balanced ? "A = L + E" : "\u5F85\u501F\u8CB8\u5E73\u8861";
    document.getElementById("reconResultLabel").textContent = result >= 0 ? "\u672C\u671F\u6DE8\u5229\u6F64 Net profit" : "\u672C\u671F\u6DE8\u8667\u640D Net loss";
    document.getElementById("reconResult").textContent = money(result);
    document.getElementById("reconNote").innerHTML = balanced ? "<strong>\u5DF2\u5E73\u8861\uFF1A</strong>\u6240\u9078\u8CA1\u5E74\u7684\u501F\u65B9\u53CA\u8CB8\u65B9\u7E3D\u984D\u76F8\u7B49\u3002" : "<strong>\u5F85\u6838\u5C0D\uFF1A</strong>\u6240\u9078\u8CA1\u5E74\u4ECD\u6709 " + money(diff) + " " + (diff > 0 ? "\u501F\u65B9" : "\u8CB8\u65B9") + " \u5DEE\u984D\uFF0C\u8ACB\u6AA2\u67E5\u671F\u521D\u6578\u53CA Voucher\u3002";
  }
  var reconcileModal = document.getElementById("reconcileModal");

  // web-src/ui.ts
  var loginForm = document.getElementById("loginForm");
  var loginUser = document.getElementById("loginUser");
  var loginPassword = document.getElementById("loginPassword");
  var loginError = document.getElementById("loginError");
  var authorizedPasswordHash = "dd89871aa925e5084bcb39d2b562628fcf9373a3d6322d5365171449b88bf62c";
  async function hashLoginPassword(value) {
    const bytes = new TextEncoder().encode(value), digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function clearLoginError() {
    loginError.classList.remove("show");
    loginUser.removeAttribute("aria-invalid");
    loginPassword.removeAttribute("aria-invalid");
  }
  var appShell = document.getElementById("appShell");
  var sidebarToggle = document.getElementById("sidebarToggle");
  var sidebarContent = document.querySelectorAll("#desktopSidebar > :not(.sidebar-toggle)");
  function setSidebarCollapsed(collapsed) {
    appShell.classList.toggle("sidebar-collapsed", collapsed);
    sidebarToggle.textContent = collapsed ? "\xBB" : "\xAB";
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "\u5C55\u958B\u5DE6\u5074\u5DE5\u5177\u6B04" : "\u6536\u8D77\u5DE6\u5074\u5DE5\u5177\u6B04";
    sidebarToggle.setAttribute("aria-label", label);
    sidebarToggle.title = label;
    sidebarContent.forEach((element) => {
      element.hidden = collapsed;
    });
  }
  var fmt = (n) => formatCentsAbs(n);
  var signedFmt = (n) => formatCentsSigned(n);
  var money = (n) => "HK$ " + signedFmt(n);
  var esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  var pad2 = (n) => String(n).padStart(2, "0");
  var today = /* @__PURE__ */ new Date();
  var todayISO = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  var currentFiscalStart = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  var accountCodeCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  var monthNumber = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  function navigate(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
    document.querySelectorAll("[data-route]").forEach((b) => b.classList.toggle("active", b.dataset.route === id));
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (id === "voucher") syncAccountSelectors();
    if (id === "ledger") renderLedger();
    if (id === "reports") renderReport();
  }
  var salesChannels = [{ key: "ar", label: "AR \u8CD2\u92B7" }, { key: "online", label: "Online Sales" }, { key: "pmq", label: "PMQ \u9580\u5E02" }];
  function renderStaffNames() {
    const names = [...store.staffNames].filter((name) => !store.suppressedStaffNames.has(name)).sort((a, b) => a.localeCompare(b));
    document.getElementById("staffNameList").innerHTML = names.map((name) => `<option value="${esc(name)}"></option>`).join("");
    const manager = document.getElementById("staffNameListManager");
    manager.innerHTML = names.length ? names.map((name) => `<div class="staff-name-row"><span>${esc(name)}</span><button class="btn danger remove-staff-name" type="button" data-name="${esc(name)}">\u522A\u9664</button></div>`).join("") : '<div class="empty">\u672A\u6709\u5DF2\u5132\u5B58\u7684\u5E38\u7528\u4EBA\u540D</div>';
    manager.querySelectorAll(".remove-staff-name").forEach((btn) => btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      store.suppressedStaffNames.add(name);
      store.staffNames.delete(name);
      renderStaffNames();
    }));
  }
  var staffManager = document.getElementById("staffManager");
  var manageStaffNames = document.getElementById("manageStaffNames");
  function toggleStaffManager(open) {
    staffManager.hidden = !open;
    manageStaffNames.setAttribute("aria-expanded", String(open));
    if (open) renderStaffNames();
  }
  function openDownloadPopup2(blob, filename, title) {
    const url = URL.createObjectURL(blob), w = window.open("", "_blank");
    if (!w || w.closed) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
      }
      return null;
    }
    w.document.write('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>body{font-family:-apple-system,"PingFang HK","Microsoft JhengHei",sans-serif;padding:36px 20px;text-align:center;line-height:1.9;color:#222}h1{font-size:22px;margin:0 0 20px}#dl{display:inline-block;font-size:20px;font-weight:700;padding:16px 30px;border:2px solid #1a73e8;border-radius:12px;color:#1a73e8;text-decoration:none}.tip{color:#666;font-size:15px;margin-top:18px}</style></head><body><h1>' + esc(title) + '</h1><a id="dl" href="' + url + '" download="' + esc(filename) + '">\u64B3\u5462\u5EA6\u4E0B\u8F09 ' + esc(filename) + '</a><p class="tip">\u5982\u679C\u5187\u81EA\u52D5\u958B\u59CB\uFF0C\u8ACB\u64B3\u4E0A\u9762\u689D\u9023\u7D50</p><script>setTimeout(function(){(document.getElementById("dl") as HTMLAnchorElement).click();},300);<\/script></body></html>');
    w.document.close();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
      }
    }, 5 * 60 * 1e3);
    return { win: w, url };
  }
  async function copyTextToClipboard(text, statusEl) {
    const showCopied = (ok2) => {
      try {
        if (!statusEl) return;
        let note = statusEl.querySelector(".copy-note");
        if (!note) {
          note = document.createElement("span");
          note.className = "copy-note";
          statusEl.appendChild(note);
        }
        note.textContent = " \xB7 " + (ok2 ? "\u2713 \u5DF2\u8907\u88FD\uFF0C\u53EF\u8CBC\u4E0A\u4EFB\u4F55\u5730\u65B9\u5132\u5B58" : "\u8907\u88FD\u5931\u6557\uFF0C\u8ACB\u624B\u52D5\u9577\u6309\u8907\u88FD");
      } catch (e) {
      }
    };
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        try {
          ta.focus();
          ta.select();
          try {
            ta.setSelectionRange(0, ta.value.length);
          } catch (e) {
          }
          ok = document.execCommand("copy");
        } catch (e) {
          ok = false;
        }
        ta.remove();
      } catch (e) {
        ok = false;
      }
    }
    showCopied(ok);
    return ok;
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      if (!file || typeof FileReader === "undefined") {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name || "attachment", type: file.type || "application/octet-stream", lastModified: Number(file.lastModified) || 0, data: String(reader.result) });
      reader.onerror = () => reject(new Error("\u9644\u4EF6\u8B80\u53D6\u5931\u6557\uFF1A" + (file.name || "\u672A\u547D\u540D\u6587\u4EF6")));
      reader.readAsDataURL(file);
    });
  }
  function dataURLToFile(saved) {
    if (!saved || !saved.data) return null;
    const match = String(saved.data).match(/^data:([^;,]*)(;base64)?,(.*)$/s);
    if (!match) throw new Error("\u5099\u4EFD\u5167\u7684\u9644\u4EF6\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
    const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new File([bytes], saved.name || "attachment", { type: saved.type || match[1] || "application/octet-stream", lastModified: Number(saved.lastModified) || Date.now() });
  }

  // desktop/shims/ui.ts
  function downloadHint(opened) {
    const o = opened;
    if (o && o.desktopSaved) return "\u5DF2\u5132\u5B58\uFF1A" + o.desktopSaved;
    if (o && o.desktopCancelled) return "\u5DF2\u53D6\u6D88\u5132\u5B58";
    return null;
  }
  var openDownloadPopup = (blob, filename, title) => {
    const hook = window.__tgNativeDownload;
    if (hook) {
      const sentinel = { __desktopPending: true };
      Promise.resolve(hook(blob, filename, title)).then((res) => {
        const hint = downloadHint(res);
        if (!hint) return;
        for (const id of ["exportStatus", "backupStatus"]) {
          const el = document.getElementById(id);
          if (el && el.textContent && el.textContent.indexOf("\u5DF2\u958B\u65B0\u8996\u7A97") === 0) {
            el.textContent = hint;
          }
        }
      }).catch((e) => console.error("[desktop] native download failed:", e));
      return sentinel;
    }
    return openDownloadPopup2(blob, filename, title);
  };

  // web-src/core/invoices.ts
  function openingEntry2(fy, name, openingBalances) {
    const rec = openingBalances[fy.key]?.[name];
    if (rec == null) return { debit: 0, credit: 0 };
    if (typeof rec === "number") return { debit: rec, credit: 0 };
    return { debit: rec.debit, credit: rec.credit };
  }
  function openingInvoiceRows(kind, party, fy, ctx2) {
    const prefix = kind === "AR" ? "Accounts Receivable of " : "Accounts Payable of ";
    const target = normalParty(party);
    const storeMap = ctx2.openingInvoiceDetails[fy.key] || {};
    return Object.entries(storeMap).flatMap(([accountName, items]) => {
      if (!accountName.startsWith(prefix) || normalParty(accountName.slice(prefix.length)) !== target)
        return [];
      const entry = openingEntry2(fy, accountName, ctx2.openingBalances);
      const expected = kind === "AR" ? entry.debit : entry.credit;
      const total = items.reduce((sum, item) => sum + item.amount, 0);
      if (!items.length || expected !== total) return [];
      return items.map(
        (item) => [item.date, item.invoiceNo, party, item.amount, "opening"]
      );
    });
  }
  function accountHasFiscalActivity2(account, fy, ctx2) {
    if (!account || !fy) return false;
    if (fy.start === 2023 && !ctx2.deletedDataYears.has(fy.key) && account.importedBalance !== 0)
      return true;
    const opening = openingEntry2(fy, account.name, ctx2.openingBalances);
    if (opening.debit !== 0 || opening.credit !== 0) return true;
    return ctx2.vouchers.some(
      (v) => dateInFiscalYear(v.date, fy) && v.lines.some(
        (line) => line.account === account.name && (line.debit || line.credit)
      )
    );
  }
  function voucherDerivedInvoices(kind, fy, ctx2) {
    const isAR = kind === "AR";
    const partyPrefix = isAR ? "Accounts Receivable of " : "Accounts Payable of ";
    return ctx2.vouchers.filter((v) => dateInFiscalYear(v.date, fy)).flatMap((v) => {
      const hasCounterpart = v.lines.some((line) => {
        const account = ctx2.accounts.find((a) => a.name === line.account);
        return account && accountHasFiscalActivity2(account, fy, ctx2) && (isAR ? account.type === "\u6536\u5165" && /sales/i.test(account.name) && line.credit > 0 : account.type === "\u6210\u672C" && /purchase/i.test(account.name) && line.debit > 0);
      });
      if (!hasCounterpart) return [];
      return v.lines.filter(
        (line) => line.account.startsWith(partyPrefix) && (isAR ? line.debit > 0 : line.credit > 0)
      ).map((line) => {
        const match = String(line.detail || "").match(/inv#?\s*([a-z0-9-]+)/i);
        const invoiceNo = match ? match[0].replace(/#|\s/g, "").toUpperCase() : v.no;
        const party = line.account.slice(partyPrefix.length);
        const amount = isAR ? line.debit : line.credit;
        return [v.date, invoiceNo, party, amount, "voucher", v.no, line.detail || ""];
      });
    });
  }
  function invoiceMatches2(kind, party, fy, ctx2) {
    const source = kind === "AR" ? ctx2.salesInvoices : ctx2.purchaseInvoices;
    const p = normalParty(party);
    const base = source.filter((r) => {
      const x = normalParty(r[2]);
      return dateInFiscalYear(r[0], fy) && (x === p || x.includes(p) || p.includes(x));
    }).concat(openingInvoiceRows(kind, party, fy, ctx2));
    const known = new Set(base.map((r) => String(r[1] || "").trim().toLowerCase()));
    const derived = voucherDerivedInvoices(kind, fy, ctx2).filter((r) => {
      const x = normalParty(r[2]);
      return (x === p || x.includes(p) || p.includes(x)) && !known.has(String(r[1] || "").trim().toLowerCase());
    });
    return base.concat(derived).sort((a, b) => a[0].localeCompare(b[0]));
  }

  // web-src/core/allocation.ts
  function allocatedTotal2(kind, invoiceNo, fy, allocations) {
    return allocations.filter((x) => x.kind === kind && x.invoiceNo === invoiceNo && dateInFiscalYear(x.date, fy)).reduce((s, x) => s + x.amount, 0);
  }
  function openingInvoiceStatus2(accountName, fy, ctx2, expectedOverride = null) {
    const items = (ctx2.openingInvoiceDetails[fy.key] || {})[accountName] || [];
    const kind = accountName.startsWith("Accounts Receivable of ") ? "AR" : accountName.startsWith("Accounts Payable of ") ? "AP" : "";
    const entry = openingEntry2(fy, accountName, ctx2.openingBalances);
    const expected = expectedOverride === null ? kind === "AR" ? entry.debit : entry.credit : expectedOverride;
    const total = items.reduce((sum, item) => sum + item.amount, 0);
    const difference = expected - total;
    const state = !items.length ? "unsplit" : difference === 0 ? "complete" : "pending";
    return { state, items, expected, total, difference };
  }
  function applyAllocation(v, ctx2) {
    const priorAllocs = ctx2.allocations || [];
    const newAllocations = [];
    const reviews = [];
    const workingAllocs = priorAllocs.slice();
    let needsReview = false;
    const fy = fiscalYearForDate(v.date);
    v.lines.forEach((line) => {
      let kind = "";
      let amount = 0;
      let party = "";
      if (line.account.startsWith("Accounts Receivable of ")) {
        kind = "AR";
        amount = line.credit - line.debit;
        party = line.account.replace("Accounts Receivable of ", "");
      } else if (line.account.startsWith("Accounts Payable of ")) {
        kind = "AP";
        amount = line.debit - line.credit;
        party = line.account.replace("Accounts Payable of ", "");
      }
      if (!kind || amount <= 0) return;
      const openingStatus = openingInvoiceStatus2(line.account, fy, ctx2);
      if (openingStatus.state === "pending") {
        reviews.push({
          voucher: v.no,
          kind,
          party,
          amount,
          reason: "\u671F\u521D\u767C\u7968\u660E\u7D30\u5F85\u5B8C\u6210\uFF0C\u6536\uFF0F\u4ED8\u6B3E\u7DAD\u6301\u7E3D\u984D\u8655\u7406"
        });
        needsReview = true;
        return;
      }
      let invoices = invoiceMatches2(kind, party, fy, ctx2);
      let remaining = amount;
      if (v.allocationInvoice) {
        const target = invoices.find((r) => r[1] === v.allocationInvoice);
        if (!target) {
          reviews.push({
            voucher: v.no,
            kind,
            party,
            amount,
            reason: "\u6307\u5B9A\u767C\u7968\u865F\u8207\u6B64\u5BA2\u6236\uFF0F\u4F9B\u61C9\u5546\u4E0D\u7B26"
          });
          needsReview = true;
          return;
        }
        invoices = [target];
      }
      for (const inv of invoices) {
        const available = Math.max(0, inv[3] - allocatedTotal2(kind, inv[1], fy, workingAllocs));
        if (available <= 0) continue;
        const applied = Math.min(available, remaining);
        const rec = {
          kind,
          invoiceNo: inv[1],
          party: inv[2],
          date: v.date,
          amount: applied,
          voucher: v.no,
          source: v.allocationInvoice ? "\u6307\u5B9A\u767C\u7968" : "FIFO"
        };
        newAllocations.push(rec);
        workingAllocs.push(rec);
        remaining = remaining - applied;
        if (remaining <= 0) break;
      }
      if (remaining > 0) {
        reviews.push({
          voucher: v.no,
          kind,
          party,
          amount: remaining,
          reason: v.allocationInvoice ? "\u6307\u5B9A\u767C\u7968\u7D50\u6B20\u4E0D\u8DB3" : "\u627E\u4E0D\u5230\u8DB3\u5920\u672A\u6E05\u767C\u7968"
        });
        needsReview = true;
      }
    });
    return { newAllocations, reviews, needsReview };
  }

  // web-src/state.ts
  var store = {
    fiscalYears: [makeFiscalYear(2023), makeFiscalYear(currentFiscalStart)].filter((fy, i, a) => a.findIndex((x) => x.key === fy.key) === i).sort((a, b) => b.start - a.start),
    selectedFiscalKey: String(currentFiscalStart),
    deleteFiscalCandidate: null,
    deleteFiscalStep: 1,
    deletedDataYears: /* @__PURE__ */ new Set(),
    balanceAdjustments: {},
    openingBalances: {},
    openingInvoiceDetails: {},
    accounts: [
      ["1000", "Bank Saving Account", "\u8CC7\u7522", 15564.22, "dr"],
      ["1010", "Bank Current Account", "\u8CC7\u7522", 0.9, "dr"],
      ["1101", "Accounts Receivable of Toy Hunters", "\u8CC7\u7522", 100100, "dr"],
      ["1102", "Accounts Receivable of Animation International Limited", "\u8CC7\u7522", 13e3, "dr"],
      ["1103", "Accounts Receivable of SDD Marketing & Consultary Limited", "\u8CC7\u7522", 9295, "dr"],
      ["1104", "Accounts Receivable of Kidsland LCS Limited", "\u8CC7\u7522", 22530, "dr"],
      ["1105", "Accounts Receivable of Tran Kevin", "\u8CC7\u7522", 2760, "dr"],
      ["1106", "Accounts Receivable of Sim Wee Lun", "\u8CC7\u7522", 2028, "dr"],
      ["1107", "Accounts Receivable of Edwin", "\u8CC7\u7522", 2136, "dr"],
      ["1108", "Accounts Receivable of Amaz Co Ltd", "\u8CC7\u7522", 4564, "dr"],
      ["1109", "Accounts Receivable of Gift Field Ltd", "\u8CC7\u7522", 15960, "dr"],
      ["1110", "Accounts Receivable of Kenneth", "\u8CC7\u7522", 2072, "dr"],
      ["1111", "Accounts Receivable of \u5289\u5FD7\u5049", "\u8CC7\u7522", 1e4, "dr"],
      ["1112", "Accounts Receivable of \u738B\u4E1E\u6F22", "\u8CC7\u7522", 2480, "dr"],
      ["1113", "Accounts Receivable of \u4E0A\u539F(\u6FB3\u9580)\u6709\u9650\u516C\u53F8", "\u8CC7\u7522", 11088, "dr"],
      ["1114", "Accounts Receivable of Toys Wonderland Ltd", "\u8CC7\u7522", 5208, "dr"],
      ["1115", "Accounts Receivable of Big Box International Pte Ltd", "\u8CC7\u7522", 21300, "dr"],
      ["2050", "Temporary Receivable", "\u8CA0\u50B5", 21390, "cr"],
      ["1300", "Closing Stock", "\u8CC7\u7522", 555138.41, "dr"],
      ["1500", "Furniture and Equipment", "\u8CC7\u7522", 22881, "dr"],
      ["1510", "Moulds", "\u8CC7\u7522", 57e3, "dr"],
      ["2000", "Accounts Payable of Wingo Creative Co Ltd", "\u8CA0\u50B5", 365893.4, "cr"],
      ["2010", "Accrued Expenses", "\u8CA0\u50B5", 142300, "cr"],
      ["2100", "Current Account of Lam Hon Fai", "\u8CA0\u50B5", 176488.5, "cr"],
      ["2201", "Loan of Hong Kong Enterprise Association Limited", "\u8CA0\u50B5", 22e4, "cr"],
      ["2202", "Loan of Hong Kong Safety Service Ltd", "\u8CA0\u50B5", 43e4, "cr"],
      ["2203", "Loan of Hong Kong Fiduciary Association Ltd", "\u8CA0\u50B5", 2e5, "cr"],
      ["1400", "Suspense Account \u2014 source workbook difference", "\u8CC7\u7522", 99520, "dr"],
      ["3000", "Capital of Lam Hon Fai", "\u6B0A\u76CA", 100, "cr"],
      ["3100", "Profit and Loss account", "\u8CC7\u7522", 689742.57, "dr"],
      ["4000", "Sales", "\u6536\u5165", 111007026e-2, "cr"],
      ["4010", "Bank Interest", "\u6536\u5165", 571.98, "cr"],
      ["4020", "Sundry Income", "\u6536\u5165", 1291.18, "cr"],
      ["5000", "Opening Stock", "\u6210\u672C", 54144.83, "dr"],
      ["5010", "Purchases", "\u6210\u672C", 919497.21, "dr"],
      ["5020", "Closing Stock Adjustment", "\u6210\u672C", 555138.41, "cr"],
      ["6000", "Advertising Fee", "\u8CBB\u7528", 77887.8, "dr"],
      ["6010", "Rent", "\u8CBB\u7528", 137500, "dr"],
      ["6020", "Bank Charges", "\u8CBB\u7528", 2502.53, "dr"],
      ["6030", "Toys Membership Fee", "\u8CBB\u7528", 9666.7, "dr"],
      ["6040", "Sundry Expenses", "\u8CBB\u7528", 22692.96, "dr"],
      ["6050", "Business Trip", "\u8CBB\u7528", 56304.34, "dr"],
      ["6060", "Discount allowance", "\u8CBB\u7528", 1104, "dr"],
      ["6070", "Salary and allowance", "\u8CBB\u7528", 686e3, "dr"],
      ["6080", "I Cloud fee", "\u8CBB\u7528", 4803.25, "dr"],
      ["6090", "Booth Fee", "\u8CBB\u7528", 96640, "dr"],
      ["6100", "Printing and Stationary", "\u8CBB\u7528", 5187, "dr"],
      ["6110", "Insurance", "\u8CBB\u7528", 4500, "dr"],
      ["6120", "Business Registration", "\u8CBB\u7528", 2150, "dr"],
      ["6130", "Transportation Fee", "\u8CBB\u7528", 10590.2, "dr"],
      ["6140", "Entertainment", "\u8CBB\u7528", 5662, "dr"],
      ["6150", "Website Fee", "\u8CBB\u7528", 1016, "dr"],
      ["6160", "Secretary Fee", "\u8CBB\u7528", 1650, "dr"],
      ["6170", "Courier Fee", "\u8CBB\u7528", 12646.26, "dr"],
      ["1520", "Prototype", "\u8CC7\u7522", 0, "dr"],
      ["1590", "Accumulated Depreciation", "\u8CC7\u7522", 0, "cr"],
      ["6190", "Copy Right", "\u8CBB\u7528", 80943.12, "dr"],
      ["6200", "MPF", "\u8CBB\u7528", 12750, "dr"]
    ].map((a) => ({ code: a[0], name: a[1], type: a[2], balance: dollarsToCents(a[3]), importedBalance: dollarsToCents(a[3]), side: a[4] })),
    salesInvoices: [
      ["2023-04-12", "INV2023040017", "Toy Hunters", 2820],
      ["2023-04-24", "INV2023040018", "Alpha-C Group Ltd", 27010],
      ["2023-04-24", "INV2023040019", "DoraFansHK Ltd", 7920],
      ["2023-04-24", "INV2023040020", "DoraFansHK Ltd", 3090],
      ["2023-04-24", "INV2023040021", "SDD Marketing & Consultancy Ltd", 5759],
      ["2023-04-24", "INV2023040022", "DoraFansHK Ltd", 18774],
      ["2023-04-24", "INV2023040023", "DoraFansHK Ltd", 8459],
      ["2023-05-05", "INV2023050024", "Toy Hunters", 5640],
      ["2023-05-25", "INV2023050025", "Kidsland LCS Limited", 2370],
      ["2023-05-29", "INV2023050026", "Contemp Consultant Limited", 13888],
      ["2023-06-12", "INV2023060028", "DoraFansHK Ltd", 1470],
      ["2023-07-06", "INV2023070029", "Lofty Limited", 1185],
      ["2023-07-06", "INV2023070030", "Lofty Limited", 1185],
      ["2023-07-06", "INV2023070031", "Lofty Limited", 2370],
      ["2023-07-12", "INV2023070032", "DoraFansHK Ltd", 2704],
      ["2023-07-12", "INV2023070033", "SweetyMagic Limited", 16520],
      ["2023-07-12", "INV2023070034", "Contemp Consultant Limited", 18581.4],
      ["2023-08-01", "INV2023080035", "Tran Kevin", 2760],
      ["2023-08-05", "INV2023080036", "Zebra Toys Limited", 108602],
      ["2023-08-10", "INV2023080037", "Kidsland LCS Limited", 6210],
      ["2023-08-10", "INV2023080038", "Kidsland LCS Limited", 4674],
      ["2023-08-14", "INV2023080039", "Lofty Limited", 2037.75],
      ["2023-08-29", "INV2023080040", "Sim Wee Lun", 780],
      ["2023-08-29", "INV2023080041", "Zebra Toys Limited", 15600],
      ["2023-08-29", "INV2023080043", "SDD Marketing & Consultancy Ltd", 4550],
      ["2023-08-29", "INV2023080044", "SDD Marketing & Consultancy Ltd", 962],
      ["2023-08-30", "INV2023080045", "Edwin", 948],
      ["2023-08-30", "INV2023080046", "Edwin", 1188],
      ["2023-09-06", "INV2023090047", "Sim Wee Lun", 1248],
      ["2023-09-24", "INV2023090048", "Animation International Ltd", 9388.4],
      ["2023-09-14", "INV2023090049", "SDD Marketing & Consultancy Ltd", 4810],
      ["2023-09-14", "INV2023090050", "DoraFansHK Ltd", 8264],
      ["2023-09-14", "INV2023090051", "DoraFansHK Ltd", 8030],
      ["2023-09-21", "INV2023090052", "\u6771\u654F\u5BE6\u696D\u6709\u9650\u516C\u53F8", 41940],
      ["2023-09-28", "INV2023090053", "Kidsland LCS Limited", 6210],
      ["2023-10-16", "INV2023100054", "Kidsland LCS Limited", 3765],
      ["2023-10-16", "INV2023100055", "Kidsland LCS Limited", 5835],
      ["2023-10-16", "INV2023100056", "Kidsland LCS Limited", 4350],
      ["2023-10-20", "INV2023100057", "SDD Marketing & Consultancy Ltd", 247],
      ["2023-10-25", "INV2023100058", "Amaz Co Ltd", 16520],
      ["2023-10-25", "INV2023100059", "Amaz Co Ltd", 6216],
      ["2023-10-27", "INV2023100060", "Gift Field Limited", 15960],
      ["2023-10-27", "INV2023100061", "Kenneth", 2072],
      ["2023-11-06", "INV2023110062", "Amaz Co Ltd", 1316],
      ["2023-11-09", "INV2023110063", "Toy Hunters", 14072],
      ["2023-11-09", "INV2023110064", "\u5289\u5FD7\u5049", 1e4],
      ["2023-11-08", "INV2023110065", "Lofty Limited", 2370],
      ["2023-11-08", "INV2023110066", "Lofty Limited", 2151],
      ["2023-11-20", "INV2023110067", "Toy Hunters", 22668],
      ["2023-11-20", "INV2023110068", "\u738B\u4E1E\u6F22", 2480],
      ["2023-12-08", "INV2023120070", "SDD Marketing & Consultancy Ltd", 2184],
      ["2023-12-14", "INV2023120071", "\u4E0A\u539F(\u6FB3\u9580)\u6709\u9650\u516C\u53F8", 20580],
      ["2023-12-14", "INV2023120072", "Ocean Trading Co", 19880],
      ["2024-01-02", "INV2024010001", "\u99AC\u9AD8\u65AF", 3960],
      ["2024-01-11", "INV2024010002", "SDD Marketing & Consultancy Ltd", 1768],
      ["2024-01-11", "INV2024010003", "Amaz Co Ltd", 4564],
      ["2024-01-11", "INV2024010004", "\u4E0A\u539F(\u6FB3\u9580)\u6709\u9650\u516C\u53F8", 11088],
      ["2024-01-15", "INV2024010005", "Lofty Limited", 2930.4],
      ["2024-01-19", "INV2024010006", "SDD Marketing & Consultancy Ltd", 1768],
      ["2024-01-30", "INV2024010007", "Toy Hunters", 10680],
      ["2024-02-06", "INV2024020008", "SDD Marketing & Consultancy Ltd", 117],
      ["2024-02-16", "INV2024020009", "TOCA LOCA Limited", 7072],
      ["2024-02-16", "INV2024020010", "Ocean Trading Co", 25020],
      ["2024-02-16", "INV2024020011", "Amaz Co Ltd", 12544],
      ["2024-02-16", "INV2024020012", "Toys Wonderland Limited", 5208],
      ["2024-02-16", "INV2024020013", "Kenneth Feng", 2072],
      ["2024-02-19", "INV2024020014", "Toy Hunters", 6150],
      ["2024-02-27", "INV2024020015", "SDD Marketing & Consultancy Ltd", 2509],
      ["2024-03-05", "INV2024020016", "Winner Concept International Ltd", 1222],
      ["2024-03-07", "INV2023020020", "TOCA LOCA Limited", 11843],
      ["2024-03-07", "INV2024010021", "Lofty Limited", 6453],
      ["2024-03-15", "INV2024030022", "Big Box International Pte Ltd", 17540],
      ["2024-03-15", "INV2024030023", "Big Box International Pte Ltd", 3760]
    ].map((r) => [r[0], r[1], r[2], dollarsToCents(r[3])]),
    purchaseInvoices: [["2023-06-27", "WMI-23-T015", "Wingo Creative Co Limited", 5822], ["2023-06-27", "WMI-23-T016", "Wingo Creative Co Limited", 8998], ["2023-07-31", "WMI-23-T017", "Wingo Creative Co Limited", 102095], ["2023-06-27", "WMI-23-T018", "Wingo Creative Co Limited", 50948], ["2023-09-01", "\u2014", "Takumi Iwase", 23611.03], ["2023-09-13", "WMI-23-T019", "Wingo Creative Co Limited", 320864], ["2023-09-13", "WMI-23-T020", "Wingo Creative Co Limited", 142730.3], ["2023-09-13", "WMI-23-T021", "Wingo Creative Co Limited", 73625.3], ["2023-09-13", "WMI-23-T023", "Wingo Creative Co Limited", 41137.8], ["2023-10-26", "WMI-23-T024", "Wingo Creative Co Limited", 108400], ["2024-02-19", "\u2014", "Adore Marketing", 41244.78]].map((r) => [r[0], r[1], r[2], dollarsToCents(r[3])]),
    invoiceRemarks: { "INV2023040018": "paid on Apr 2023", "INV2023040019": "paid on Apr 2023", "INV2023040020": "paid on Apr 2023", "INV2023040021": "paid on Jun 2023", "INV2023040022": "paid on May 2023", "INV2023040023": "paid on May 2023", "INV2023050026": "paid on Jun 2023", "INV2023060028": "paid on Jun 2023", "INV2023070029": "paid on Jul 2023", "INV2023070030": "paid on Jul 2023", "INV2023070031": "paid on Jul 2023", "INV2023070032": "paid on Jul 2023", "INV2023070033": "paid on Jul 2023", "INV2023070034": "paid on Jul 2023", "INV2023080036": "paid on Aug 2023", "INV2023080037": "paid on Oct 2023", "INV2023080038": "paid on Oct 2023", "INV2023080039": "paid on Jan 2024", "INV2023080041": "paid on Aug 2023", "INV2023080043": "paid on Sep 2023", "INV2023080044": "paid on Sep 2023", "INV2023090048": "paid on Feb 2024", "INV2023090049": "paid on Sep 2023", "INV2023090050": "paid on Sep 2023", "INV2023090051": "paid on Sep 2023", "INV2023090052": "paid on Nov 2023", "INV2023100058": "paid on Nov 2023", "INV2023100059": "paid on Nov 2023", "INV2023100061": "paid on Nov 2023", "INV2023110062": "paid on Dec 2023", "INV2023110065": "paid on Jan 2024", "INV2023110066": "paid on Jan 2024", "INV2023120070": "paid on Dec 2023", "INV2023120071": "paid on Dec 2023", "INV2023120072": "paid on Jan 2024", "INV2024010001": "paid on Jan 2024", "INV2024010005": "paid on Jan 2024", "INV2024020008": "paid on Feb 2024", "INV2024020009": "paid on Feb 2024", "INV2024020010": "paid on Feb 2024", "INV2024020011": "paid on Mar 2024", "INV2024020015": "paid on Feb 2024", "INV2024020016": "paid on Mar 2024", "INV2023020020": "paid on Mar 2024", "INV2024010021": "paid on Mar 2024", "WMI-23-T015": "RM5370", "WMI-23-T016": "RM8300", "WMI-23-T017": "RM94183", "WMI-23-T018": "RM47000", "WMI-23-T019": "RM296000", "WMI-23-T020": "RM131670", "WMI-23-T021": "RM67920", "WMI-23-T023": "RM37950", "WMI-23-T024": "RM100000" },
    allocations: [],
    allocationReview: [],
    vouchers: [
      { no: "B091423", type: "B", date: "2023-09-22", desc: "Lam Hon Fai transfer to saving account", allocationInvoice: "", madeBy: "", checkedBy: "", approvedBy: "", attachments: [], lines: [{ account: "Current Account of Lam Hon Fai", detail: "Transfer to saving account", debit: 142800, credit: 0 }, { account: "Bank Saving Account", detail: "Transfer from director current account", debit: 0, credit: 142800 }] },
      { no: "T100223", type: "T", date: "2023-10-31", desc: "Lunch & Dinner with client & tissue, tea bag, cleaning tools for office", allocationInvoice: "", madeBy: "", checkedBy: "", approvedBy: "", attachments: [], lines: [{ account: "Entertainment", detail: "Office and client expenses", debit: 717650, credit: 0 }, { account: "Current Account of Lam Hon Fai", detail: "Paid by director", debit: 0, credit: 717650 }] }
    ],
    currentType: "B",
    rows: [],
    report: "trial",
    editingIndex: null,
    numberManuallyEdited: false,
    currentAttachments: [],
    lastVoucherDates: {},
    staffNames: /* @__PURE__ */ new Set(),
    suppressedStaffNames: /* @__PURE__ */ new Set(),
    reportState: { month: null, date: "", nameQuery: "", invoiceQuery: "" },
    reconciliationConfirmations: {},
    reconciliationContext: null,
    reconcileInvoiceDraft: [],
    reconcilePaymentDraft: [],
    editingAccount: null,
    accountEditStep: 1,
    deletingAccount: null,
    deleteAccountStep: 1,
    deleteAccountUsage: [],
    openingInvoiceAccount: "",
    openingInvoiceDraft: [],
    pendingRestore: null,
    restoreStep: 1
  };
  function selectedFiscalYear() {
    return store.fiscalYears.find((fy) => fy.key === store.selectedFiscalKey) || store.fiscalYears[0];
  }
  function ctx() {
    return {
      vouchers: store.vouchers,
      accounts: store.accounts,
      salesInvoices: store.salesInvoices,
      purchaseInvoices: store.purchaseInvoices,
      openingBalances: store.openingBalances,
      openingInvoiceDetails: store.openingInvoiceDetails,
      deletedDataYears: store.deletedDataYears,
      allocations: store.allocations
    };
  }
  function dateInFiscalYear2(date, fy = selectedFiscalYear()) {
    return dateInFiscalYear(date, fy);
  }
  function openingEntry(fy, name) {
    return openingEntry2(fy, name, store.openingBalances);
  }
  function openingInvoiceStatus(accountName, fy = selectedFiscalYear(), expected = null) {
    return openingInvoiceStatus2(accountName, fy, ctx(), expected);
  }
  function accountHasFiscalActivity(account, fy = selectedFiscalYear()) {
    return accountHasFiscalActivity2(account, fy, ctx());
  }
  function invoiceMatches(kind, party, fy = selectedFiscalYear()) {
    return invoiceMatches2(kind, party, fy, ctx());
  }
  function allocatedTotal(kind, invoiceNo, fy = selectedFiscalYear()) {
    return allocatedTotal2(kind, invoiceNo, fy, store.allocations);
  }
  function applyAllocation2(v) {
    const { newAllocations, reviews, needsReview } = applyAllocation(v, ctx());
    store.allocations.push(...newAllocations);
    const revs = reviews;
    store.allocationReview.push(...revs);
    return needsReview;
  }

  // web-src/ledger.ts
  function openingNaturalBalance(account, fy = selectedFiscalYear()) {
    if (!account || !fy) return 0;
    const entry = store.openingBalances[fy.key] && store.openingBalances[fy.key][account.name];
    if (!entry) return 0;
    const signed = typeof entry === "number" ? 0 : entry.debit - entry.credit;
    return account.side === "dr" ? signed : -signed;
  }
  function accountBalance(account, fy = selectedFiscalYear()) {
    if (!account || !fy) return 0;
    const base = fy.start === 2023 && !store.deletedDataYears.has(fy.key) ? account.importedBalance : 0;
    return base + openingNaturalBalance(account, fy) + (store.balanceAdjustments[fy.key] && store.balanceAdjustments[fy.key][account.name] || 0);
  }
  function accountSignedBalance(account, fy = selectedFiscalYear()) {
    const natural = accountBalance(account, fy);
    return natural * (account && account.side === "cr" ? -1 : 1);
  }
  var fiscalAccounts = (fy = selectedFiscalYear()) => store.accounts.filter((a) => accountHasFiscalActivity(a, fy));
  function balanceLabel(account, fy = selectedFiscalYear()) {
    const signed = accountSignedBalance(account, fy);
    return signed ? signedFmt(signed) + " " + (signed < 0 ? "Cr" : "Dr") : "\u2014";
  }
  function renderLedger() {
    const fy = selectedFiscalYear(), sel = document.getElementById("ledgerAccount"), available = fiscalAccounts(fy), preferred = sel.value || "Current Account of Lam Hon Fai";
    sel.innerHTML = available.map((a2) => `<option>${esc(a2.name)}</option>`).join("");
    if (!available.length) {
      document.getElementById("ledgerBody").innerHTML = '<tr><td colspan="6" class="empty">\u6240\u9078\u8CA1\u5E74\u672A\u6709\u671F\u521D\u6578\u6216\u904E\u8CEC\u8A18\u9304</td></tr>';
      document.getElementById("ledgerClosing").textContent = "\u2014";
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.value = available.some((a2) => a2.name === preferred) ? preferred : available[0].name;
    const name = sel.value, a = store.accounts.find((x) => x.name === name), tx = [];
    store.vouchers.forEach((v, voucherIndex) => {
      if (dateInFiscalYear2(v.date, fy)) v.lines.filter((l) => l.account === name).forEach((l) => tx.push({ ...l, date: v.date, no: v.no, desc: v.desc, voucherIndex }));
    });
    let running = accountSignedBalance(a, fy);
    [...tx].reverse().forEach((t) => {
      running = running - (t.debit - t.credit);
    });
    const openingSide = running < 0 ? "Cr" : "Dr", openingAmount = Math.abs(running);
    let html = `<tr><td data-label="\u65E5\u671F">${fy.from}</td><td data-label="\u660E\u7D30 Detail">\u671F\u521D\u7D50\u9918 Balance b/d</td><td data-label="Voucher">\u2014</td><td class="num" data-label="Debit">${openingSide === "Dr" && openingAmount ? fmt(openingAmount) : "\u2014"}</td><td class="num" data-label="Credit">${openingSide === "Cr" && openingAmount ? fmt(openingAmount) : "\u2014"}</td><td class="num" data-label="\u7D50\u9918">${fmt(openingAmount)} ${openingSide}</td></tr>`;
    tx.sort((x, y) => x.date.localeCompare(y.date)).forEach((t) => {
      running = running + (t.debit - t.credit);
      html += `<tr><td data-label="\u65E5\u671F">${t.date}</td><td data-label="\u660E\u7D30 Detail">${esc(t.detail || t.desc)}</td><td data-label="Voucher"><b>${esc(t.no)}</b>${attachmentButtonHTML(t.voucherIndex)}</td><td class="num" data-label="Debit">${t.debit ? fmt(t.debit) : "\u2014"}</td><td class="num" data-label="Credit">${t.credit ? fmt(t.credit) : "\u2014"}</td><td class="num" data-label="\u7D50\u9918">${fmt(running)} ${running < 0 ? "Cr" : "Dr"}</td></tr>`;
    });
    document.getElementById("ledgerBody").innerHTML = html;
    document.getElementById("ledgerClosing").textContent = balanceLabel(a, fy);
    bindAttachmentButtons(document.getElementById("ledgerBody"));
  }

  // web-src/fiscal-years.ts
  var fiscalDataCount = (fy) => store.vouchers.filter((v) => dateInFiscalYear2(v.date, fy)).length + store.salesInvoices.filter((r) => dateInFiscalYear2(r[0], fy)).length + store.purchaseInvoices.filter((r) => dateInFiscalYear2(r[0], fy)).length + Object.keys(store.openingBalances[fy.key] || {}).length;
  function fiscalLabelRange(fy) {
    return `${fy.from.replaceAll("-", "/")} \u2014 ${fy.to.replaceAll("-", "/")}`;
  }
  function renderFiscalYears() {
    const fy = selectedFiscalYear(), select = document.getElementById("fiscalYearSelect");
    select.innerHTML = store.fiscalYears.map((x) => `<option value="${x.key}">${x.label}</option>`).join("");
    select.value = fy.key;
    document.getElementById("fiscalRange").textContent = fiscalLabelRange(fy);
    document.getElementById("dashboardFiscalRange").textContent = fiscalLabelRange(fy);
    document.getElementById("sidebarFiscalYear").textContent = fy.label + " \xB7 HKD";
    document.getElementById("voucherDate").min = fy.from;
    document.getElementById("voucherDate").max = fy.to;
    renderInvoiceNumberList();
    document.getElementById("fiscalYearList").innerHTML = store.fiscalYears.map((x) => `<div class="fy-list-row"><div><strong>${x.label}${x.key === fy.key ? " \xB7 \u4F7F\u7528\u4E2D" : ""}</strong><small>${fiscalLabelRange(x)} \xB7 ${fiscalDataCount(x)} \u7B46\u8CC7\u6599</small></div><button class="btn danger delete-fy" type="button" data-key="${x.key}" ${store.fiscalYears.length === 1 ? "disabled" : ""}>\u522A\u9664</button></div>`).join("");
    document.querySelectorAll(".delete-fy").forEach((btn) => btn.addEventListener("click", () => openDeleteFiscal(btn.dataset.key)));
  }
  function refreshFiscalScope() {
    store.reportState.month = null;
    store.reportState.date = "";
    store.editingIndex = null;
    renderFiscalYears();
    if (!openingManager.hidden) renderOpeningBalances();
    renderVoucherList();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
    document.getElementById("ledgerCount").textContent = String(store.vouchers.filter((v) => dateInFiscalYear2(v.date)).length);
    const bank = store.vouchers.find((v) => v.no === "B091423" && dateInFiscalYear2(v.date)), transfer = store.vouchers.find((v) => v.no === "T100223" && dateInFiscalYear2(v.date));
    document.getElementById("loadBank").disabled = !bank;
    document.getElementById("loadTransfer").disabled = !transfer;
    const first = store.vouchers.find((v) => dateInFiscalYear2(v.date));
    if (first) setVoucher(first, store.vouchers.indexOf(first));
    else createNewVoucher();
  }
  var fiscalManager = document.getElementById("fiscalManager");
  var manageFiscalYears = document.getElementById("manageFiscalYears");
  function toggleFiscalManager(open) {
    fiscalManager.hidden = !open;
    manageFiscalYears.setAttribute("aria-expanded", String(open));
    if (open) {
      openingManager.hidden = true;
      manageOpeningBalances.setAttribute("aria-expanded", "false");
      document.getElementById("fiscalStartYear").focus();
    }
  }
  function openDeleteFiscal(key) {
    store.deleteFiscalCandidate = store.fiscalYears.find((fy) => fy.key === key);
    if (!store.deleteFiscalCandidate) return;
    store.deleteFiscalStep = 1;
    renderDeleteFiscal();
    document.getElementById("deleteFiscalModal").hidden = false;
    document.getElementById("confirmDeleteFiscal").focus();
  }
  function renderDeleteFiscal() {
    const fy = store.deleteFiscalCandidate;
    if (!fy) return;
    const count = fiscalDataCount(fy), body = document.getElementById("deleteFiscalBody"), button = document.getElementById("confirmDeleteFiscal");
    if (store.deleteFiscalStep === 1) {
      body.innerHTML = `<p>\u4F60\u6B63\u6E96\u5099\u522A\u9664 <strong>${fy.label}</strong>\uFF08${fiscalLabelRange(fy)}\uFF09\u3002</p>${count ? `<div class="modal-warning">\u6B64\u8CA1\u5E74\u5DF2\u6709 ${count} \u7B46 Voucher\uFF0F\u767C\u7968\u8CC7\u6599\u3002\u7E7C\u7E8C\u522A\u9664\u6703\u4E00\u4F75\u522A\u9664\u8A72\u8CA1\u5E74\u6240\u6709\u8CC7\u6599\uFF0C\u4E0D\u80FD\u5FA9\u539F\u3002</div>` : "<p>\u6B64\u8CA1\u5E74\u76EE\u524D\u6C92\u6709 Voucher \u6216\u767C\u7968\u8CC7\u6599\u3002</p>"}<p>\u6309\u300C\u7E7C\u7E8C\u300D\u9032\u5165\u7B2C\u4E8C\u6B21\u78BA\u8A8D\u3002</p>`;
      button.textContent = "\u7E7C\u7E8C";
      button.className = "btn danger";
    } else {
      body.innerHTML = `<div class="modal-warning">\u7B2C\u4E8C\u6B21\u78BA\u8A8D\uFF1A\u78BA\u5B9A\u6C38\u4E45\u522A\u9664 ${fy.label}${count ? " \u53CA\u8A72\u8CA1\u5E74\u5168\u90E8 " + count + " \u7B46\u8CC7\u6599" : ""}\uFF1F</div><p>\u6B64\u52D5\u4F5C\u53EA\u5F71\u97FF\u4ECA\u6B21\u958B\u555F\u671F\u9593\u7684\u539F\u578B\u8CC7\u6599\u3002</p>`;
      button.textContent = "\u78BA\u8A8D\u522A\u9664";
      button.className = "btn danger";
    }
  }
  function closeDeleteFiscal() {
    document.getElementById("deleteFiscalModal").hidden = true;
    store.deleteFiscalCandidate = null;
    store.deleteFiscalStep = 1;
  }

  // web-src/accounts.ts
  var sortAccounts = () => store.accounts.sort((a, b) => accountCodeCollator.compare(a.code, b.code) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  var accountForm = document.getElementById("accountForm");
  var showAccountForm = document.getElementById("showAccountForm");
  var accountFormMessage = document.getElementById("accountFormMessage");
  function updateAccountCodeGuide(prefill = false) {
    const type = document.getElementById("newAccountType").value, codeInput = document.getElementById("newAccountCode"), same = store.accounts.filter((a) => !type || a.type === type).sort((a, b) => accountCodeCollator.compare(a.code, b.code)), numeric = same.map((a) => Number(a.code)).filter(Number.isFinite), suggested = numeric.length ? String(Math.ceil((Math.max(...numeric) + 1) / 10) * 10) : { \u8CC7\u7522: "1000", \u8CA0\u50B5: "2000", \u6B0A\u76CA: "3000", \u6536\u5165: "4000", \u6210\u672C: "5000", \u8CBB\u7528: "6000" }[type] || "";
    document.getElementById("accountCodeSuggestion").textContent = type ? `${type}\u985E\u4E0B\u4E00\u500B\u5EFA\u8B70\u7DE8\u865F\uFF1A${suggested || "\u8ACB\u81EA\u884C\u8F38\u5165"}` : "\u5148\u9078\u64C7\u985E\u5225\uFF0C\u7CFB\u7D71\u6703\u5EFA\u8B70\u4E0B\u4E00\u500B\u53EF\u7528\u7DE8\u865F\u3002";
    document.getElementById("usedAccountCodes").innerHTML = (same.length ? same : store.accounts).map((a) => `<span title="${esc(a.name)}">${esc(a.code)}</span>`).join("");
    if (prefill && suggested && !codeInput.value.trim()) codeInput.value = suggested;
  }
  function toggleAccountForm(open) {
    accountForm.hidden = !open;
    showAccountForm.setAttribute("aria-expanded", String(open));
    if (open) {
      accountFormMessage.textContent = "";
      accountFormMessage.className = "form-message";
      updateAccountCodeGuide();
      document.getElementById("newAccountType").focus();
    }
  }
  function renderAccounts() {
    sortAccounts();
    const q = document.getElementById("accountSearch").value.toLowerCase(), type = document.getElementById("accountType").value, filtered = store.accounts.filter((a) => (!q || a.name.toLowerCase().includes(q) || a.code.includes(q)) && (!type || a.type === type)), body = document.getElementById("accountBody");
    document.getElementById("accountCount").textContent = String(store.accounts.length);
    body.innerHTML = filtered.map((a) => {
      const balance = accountBalance(a);
      return `<tr><td data-label="\u7DE8\u78BC">${a.code}</td><td data-label="\u79D1\u76EE\u540D\u7A31"><b>${esc(a.name)}</b></td><td data-label="\u985E\u5225"><span class="type-tag">${a.type}</span></td><td class="num" data-label="\u6240\u9078\u8CA1\u5E74\u7D50\u9918">${balance ? balanceLabel(a) : "\u2014"}</td><td data-label="\u72C0\u614B"><span class="status-tag">\u555F\u7528</span></td><td data-label="\u64CD\u4F5C"><div class="account-row-actions"><button class="btn edit-account" type="button" data-code="${esc(a.code)}">\u4FEE\u6539</button><button class="btn danger delete-account" type="button" data-code="${esc(a.code)}">\u522A\u9664</button></div></td></tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">\u627E\u4E0D\u5230\u76F8\u7B26\u79D1\u76EE</td></tr>`;
    body.querySelectorAll(".edit-account").forEach((btn) => btn.addEventListener("click", () => openAccountEdit(btn.dataset.code)));
    body.querySelectorAll(".delete-account").forEach((btn) => btn.addEventListener("click", () => openDeleteAccount(btn.dataset.code)));
  }
  var openingManager = document.getElementById("openingManager");
  var manageOpeningBalances = document.getElementById("manageOpeningBalances");
  function openingProgressHTML(status, drill = false) {
    if (!status || status.state === "unsplit") return "";
    const pending = status.state === "pending", label = pending ? "\u5F85\u5B8C\u6210" : "\u5DF2\u5B8C\u6210";
    return `<div class="opening-progress ${pending ? "pending" : "complete"}${drill ? " drill" : ""}"><div><span class="${pending ? "review-tag" : "status-tag"}">${label}</span><strong>\u4EF2\u5DEE HK$ ${signedFmt(status.difference)}</strong></div><small>\u671F\u521D\u767C\u7968\u660E\u7D30\u72C0\u614B\uFF1A${label}</small></div>`;
  }
  function readOpeningDraft() {
    const draft = {};
    document.querySelectorAll("#openingBalanceBody tr[data-account]").forEach((row) => {
      const debit = toCents(row.querySelector(".opening-debit").value), credit = toCents(row.querySelector(".opening-credit").value);
      if (debit || credit) draft[row.dataset.account] = { debit, credit };
    });
    return draft;
  }
  function openingDetailCheck(row) {
    const accountName = row.dataset.account, kind = accountName.startsWith("Accounts Receivable of ") ? "AR" : accountName.startsWith("Accounts Payable of ") ? "AP" : "", expected = kind === "AR" ? toCents(row.querySelector(".opening-debit").value) : toCents(row.querySelector(".opening-credit").value);
    return openingInvoiceStatus(accountName, selectedFiscalYear(), expected);
  }
  function validateOpeningBalances() {
    let dr = 0, cr = 0;
    document.querySelectorAll("#openingBalanceBody tr[data-account]").forEach((row) => {
      dr = dr + toCents(row.querySelector(".opening-debit").value);
      cr = cr + toCents(row.querySelector(".opening-credit").value);
      const target = row.querySelector(".opening-detail-state");
      if (target) target.innerHTML = openingProgressHTML(openingDetailCheck(row));
    });
    const balanced = dr === cr, state = document.getElementById("openingBalanceState");
    state.className = "opening-status " + (balanced ? "ok" : "bad");
    state.textContent = balanced ? "\u2713 \u501F\u8CB8\u5E73\u8861" : "\u5DEE\u984D HK$ " + fmt(dr - cr) + " " + (dr > cr ? "Dr" : "Cr");
    document.getElementById("openingBalanceTotals").textContent = `Dr ${fmt(dr)} \xB7 Cr ${fmt(cr)}`;
    document.getElementById("saveOpeningBalances").disabled = !balanced;
    return balanced;
  }
  function bindOpeningInputs() {
    document.querySelectorAll("#openingBalanceBody tr[data-account]").forEach((row) => {
      const debit = row.querySelector(".opening-debit"), credit = row.querySelector(".opening-credit");
      debit.addEventListener("input", () => {
        if (toCents(debit.value) > 0) credit.value = "";
        validateOpeningBalances();
      });
      credit.addEventListener("input", () => {
        if (toCents(credit.value) > 0) debit.value = "";
        validateOpeningBalances();
      });
    });
    document.querySelectorAll(".opening-detail-btn").forEach((btn) => btn.addEventListener("click", () => openOpeningInvoiceEditor(btn.dataset.account)));
  }
  function renderOpeningBalances() {
    const fy = selectedFiscalYear();
    document.getElementById("openingFiscalLabel").textContent = `${fy.label} \xB7 ${fy.from} \u671F\u521D`;
    document.getElementById("openingBalanceBody").innerHTML = store.accounts.map((a) => {
      const value = openingEntry(fy, a.name), canDetail = a.name.startsWith("Accounts Receivable of ") || a.name.startsWith("Accounts Payable of "), detailCount = (store.openingInvoiceDetails[fy.key] && store.openingInvoiceDetails[fy.key][a.name] || []).length, detailStatus = canDetail ? openingInvoiceStatus(a.name, fy) : null;
      return `<tr data-account="${esc(a.name)}"><td data-label="\u7DE8\u78BC">${esc(a.code)}</td><td data-label="\u6703\u8A08\u79D1\u76EE"><b>${esc(a.name)}</b></td><td data-label="\u985E\u5225"><span class="type-tag">${esc(a.type)}</span></td><td class="num" data-label="\u671F\u521D\u501F\u65B9"><input class="opening-input opening-debit" type="number" min="0" step="0.01" inputmode="decimal" aria-label="${esc(a.name)} \u671F\u521D\u501F\u65B9" value="${value.debit ? fromCents(value.debit) : ""}" placeholder="0.00"></td><td class="num" data-label="\u671F\u521D\u8CB8\u65B9"><input class="opening-input opening-credit" type="number" min="0" step="0.01" inputmode="decimal" aria-label="${esc(a.name)} \u671F\u521D\u8CB8\u65B9" value="${value.credit ? fromCents(value.credit) : ""}" placeholder="0.00"></td><td data-label="\u767C\u7968\u660E\u7D30">${canDetail ? `<div class="opening-detail-cell"><button class="btn opening-detail-btn" type="button" data-account="${esc(a.name)}">${detailCount ? "\u4FEE\u6539 " + detailCount + " \u5F35" : "\uFF0B \u62C6\u5206\u767C\u7968"}</button><div class="opening-detail-state">${openingProgressHTML(detailStatus)}</div></div>` : "\u2014"}</td></tr>`;
    }).join("");
    bindOpeningInputs();
    validateOpeningBalances();
  }
  function toggleOpeningManager(open) {
    openingManager.hidden = !open;
    manageOpeningBalances.setAttribute("aria-expanded", String(open));
    if (open) {
      toggleFiscalManager(false);
      renderOpeningBalances();
    }
  }
  var accountEditModal = document.getElementById("accountEditModal");
  function accountHasEntries(account) {
    return Boolean(account.importedBalance || store.vouchers.some((v) => v.lines.some((line) => line.account === account.name)) || Object.values(store.openingBalances).some((store2) => store2 && store2[account.name]));
  }
  function openAccountEdit(code) {
    store.editingAccount = store.accounts.find((a) => a.code === code);
    if (!store.editingAccount) return;
    store.accountEditStep = 1;
    document.getElementById("editAccountCode").value = store.editingAccount.code;
    document.getElementById("editAccountName").value = store.editingAccount.name;
    document.getElementById("editAccountType").value = store.editingAccount.type;
    document.getElementById("accountEditMessage").textContent = "";
    document.getElementById("accountEditWarning").hidden = true;
    document.getElementById("saveAccountEdit").textContent = "\u5132\u5B58\u4FEE\u6539";
    accountEditModal.hidden = false;
    document.getElementById("editAccountName").focus();
  }
  function closeAccountEdit() {
    accountEditModal.hidden = true;
    store.editingAccount = null;
    store.accountEditStep = 1;
  }
  function moveNamedKey(store2, oldName, newName) {
    Object.values(store2).forEach((year) => {
      if (year && Object.prototype.hasOwnProperty.call(year, oldName)) {
        year[newName] = year[oldName];
        delete year[oldName];
      }
    });
  }
  function applyAccountEdit() {
    var _a;
    if (!store.editingAccount) return;
    const oldName = store.editingAccount.name, newName = document.getElementById("editAccountName").value.trim(), newType = document.getElementById("editAccountType").value;
    store.vouchers.forEach((v) => v.lines.forEach((line) => {
      if (line.account === oldName) line.account = newName;
    }));
    moveNamedKey(store.openingBalances, oldName, newName);
    moveNamedKey(store.openingInvoiceDetails, oldName, newName);
    moveNamedKey(store.balanceAdjustments, oldName, newName);
    store.rows.forEach((line) => {
      if (line.account === oldName) line.account = newName;
    });
    (_a = store.editingAccount).originalName ?? (_a.originalName = oldName);
    store.editingAccount.name = newName;
    const oldSide = store.editingAccount.side, newSide = newType === "\u8CC7\u7522" || newType === "\u8CBB\u7528" || newType === "\u6210\u672C" ? "dr" : "cr";
    if (oldSide !== newSide) {
      store.editingAccount.balance = -store.editingAccount.balance;
      store.editingAccount.importedBalance = -store.editingAccount.importedBalance;
      Object.values(store.balanceAdjustments).forEach((year) => {
        if (year && Object.prototype.hasOwnProperty.call(year, newName)) year[newName] = -year[newName];
      });
    }
    store.editingAccount.type = newType;
    store.editingAccount.side = newSide;
    store.editingAccount.custom = true;
    store.editingAccount.edited = true;
    closeAccountEdit();
    accountsChanged();
    renderVoucherList();
    if (!openingManager.hidden) renderOpeningBalances();
  }
  var deleteAccountModal = document.getElementById("deleteAccountModal");
  function fiscalNameForKey(key) {
    const saved = store.fiscalYears.find((fy) => fy.key === String(key)), start = Number(key);
    return saved ? saved.label : Number.isFinite(start) ? makeFiscalYear(start).label : String(key);
  }
  function accountUsageLocations(account) {
    const usage = [], name = account.name, voucherMatches = store.vouchers.filter((v) => v.lines.some((line) => line.account === name));
    const voucherYears = [...new Set(voucherMatches.map((v) => fiscalYearForDate(v.date).key))];
    voucherYears.forEach((key) => {
      const matches = voucherMatches.filter((v) => fiscalYearForDate(v.date).key === key), sample = matches.slice(0, 5).map((v) => v.no).join("\u3001"), more = matches.length > 5 ? ` \u7B49 ${matches.length} \u5F35` : "";
      usage.push(`Voucher \u5206\u9304\uFF1A${fiscalNameForKey(key)}\uFF08${sample}${more}\uFF09`);
    });
    Object.entries(store.openingBalances).forEach(([key, store2]) => {
      if (store2 && Object.prototype.hasOwnProperty.call(store2, name)) usage.push(`\u671F\u521D\u6578\uFF1A${fiscalNameForKey(key)}`);
    });
    Object.entries(store.openingInvoiceDetails).forEach(([key, store2]) => {
      const items = store2 && store2[name];
      if (Array.isArray(items) && items.length) usage.push(`\u671F\u521D\u767C\u7968\u660E\u7D30\uFF1A${fiscalNameForKey(key)}\uFF08${items.length} \u5F35\uFF09`);
    });
    if (account.importedBalance) usage.push("\u4F86\u6E90\u5DE5\u4F5C\u7C3F\u532F\u5165\u7D50\u9918\uFF1AFY2023/24");
    Object.entries(store.balanceAdjustments).forEach(([key, store2]) => {
      if (store2 && store2[name] && !voucherYears.includes(String(key))) usage.push(`\u5DF2\u904E\u8CEC\u7D50\u9918\uFF1A${fiscalNameForKey(key)}`);
    });
    if (store.rows.some((line) => line.account === name)) usage.push("\u76EE\u524D\u672A\u904E\u8CEC\u7684 Voucher \u5206\u9304");
    return usage;
  }
  function renderDeleteAccount() {
    if (!store.deletingAccount) return;
    const title = document.getElementById("deleteAccountTitle"), body = document.getElementById("deleteAccountBody"), cancel = document.getElementById("cancelDeleteAccount"), button = document.getElementById("confirmDeleteAccount");
    if (store.deleteAccountUsage.length) {
      title.textContent = "\u7121\u6CD5\u522A\u9664\u6703\u8A08\u79D1\u76EE";
      body.innerHTML = `<p><strong>${esc(store.deletingAccount.code)} \xB7 ${esc(store.deletingAccount.name)}</strong> \u6B63\u5728\u4EE5\u4E0B\u4F4D\u7F6E\u4F7F\u7528\uFF1A</p><div class="modal-warning"><ul>${store.deleteAccountUsage.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div><p>\u8ACB\u5148\u79FB\u9664\u76F8\u95DC\u5206\u9304\uFF0F\u671F\u521D\u8CC7\u6599\uFF0C\u4E4B\u5F8C\u5148\u53EF\u4EE5\u522A\u9664\u5462\u500B\u79D1\u76EE\u3002</p>`;
      cancel.hidden = true;
      button.textContent = "\u77E5\u9053";
      button.className = "btn primary";
      return;
    }
    cancel.hidden = false;
    button.className = "btn danger";
    if (store.deleteAccountStep === 1) {
      title.textContent = "\u522A\u9664\u6703\u8A08\u79D1\u76EE";
      body.innerHTML = `<p>\u4F60\u6B63\u6E96\u5099\u522A\u9664 <strong>${esc(store.deletingAccount.code)} \xB7 ${esc(store.deletingAccount.name)}</strong>\u3002</p><p>\u7CFB\u7D71\u5DF2\u6AA2\u67E5\u6240\u6709\u8CA1\u5E74\uFF1A\u672A\u6709 Voucher \u5206\u9304\u3001\u671F\u521D\u6578\u6216\u671F\u521D\u767C\u7968\u660E\u7D30\u3002\u6309\u300C\u7E7C\u7E8C\u300D\u9032\u5165\u7B2C\u4E8C\u6B21\u78BA\u8A8D\u3002</p>`;
      button.textContent = "\u7E7C\u7E8C";
    } else {
      title.textContent = "\u518D\u6B21\u78BA\u8A8D\u522A\u9664";
      body.innerHTML = `<div class="modal-warning">\u7B2C\u4E8C\u6B21\u78BA\u8A8D\uFF1A\u78BA\u5B9A\u522A\u9664 ${esc(store.deletingAccount.code)} \xB7 ${esc(store.deletingAccount.name)}\uFF1F</div><p>\u522A\u9664\u5F8C\uFF0CVoucher \u79D1\u76EE\u641C\u5C0B\u3001Ledger \u53CA\u5831\u8868\u6703\u5373\u6642\u66F4\u65B0\u3002</p>`;
      button.textContent = "\u78BA\u8A8D\u522A\u9664";
    }
  }
  function openDeleteAccount(code) {
    store.deletingAccount = store.accounts.find((account) => account.code === code);
    if (!store.deletingAccount) return;
    store.deleteAccountStep = 1;
    store.deleteAccountUsage = accountUsageLocations(store.deletingAccount);
    renderDeleteAccount();
    deleteAccountModal.hidden = false;
    document.getElementById("confirmDeleteAccount").focus();
  }
  function closeDeleteAccount() {
    deleteAccountModal.hidden = true;
    store.deletingAccount = null;
    store.deleteAccountStep = 1;
    store.deleteAccountUsage = [];
    document.getElementById("cancelDeleteAccount").hidden = false;
  }
  var openingInvoiceModal = document.getElementById("openingInvoiceModal");
  function openingExpected(accountName) {
    const row = [...document.querySelectorAll("#openingBalanceBody tr[data-account]")].find((el) => el.dataset.account === accountName);
    if (!row) return 0;
    return accountName.startsWith("Accounts Receivable of ") ? toCents(row.querySelector(".opening-debit").value) : toCents(row.querySelector(".opening-credit").value);
  }
  function validateOpeningInvoiceDraft() {
    const expected = openingExpected(store.openingInvoiceAccount), complete = store.openingInvoiceDraft.every((item) => item.date && item.invoiceNo.trim() && item.amount > 0), unique = new Set(store.openingInvoiceDraft.map((item) => item.invoiceNo.trim().toLowerCase())).size === store.openingInvoiceDraft.length, total = store.openingInvoiceDraft.reduce((sum, item) => sum + item.amount, 0), split = store.openingInvoiceDraft.length > 0, difference = expected - total, finished = difference === 0, canSave = !split || complete && unique, state = document.getElementById("openingInvoiceState");
    document.getElementById("openingInvoiceExpected").textContent = `\u671F\u521D\u7E3D\u6578 ${fmt(expected)} \xB7 \u660E\u7D30\u5408\u8A08 ${fmt(total)}`;
    state.style.color = !split || finished ? "var(--good)" : complete && unique ? "var(--warn)" : "var(--bad)";
    state.textContent = !split ? "\u672A\u62C6\u5206\uFF08\u4FDD\u6301\u7E3D\u6578\u5165\u8CEC\uFF09" : !complete ? "\u8ACB\u5B8C\u6210\u6BCF\u5F35\u767C\u7968\u8CC7\u6599" : !unique ? "\u767C\u7968\u7DE8\u865F\u4E0D\u53EF\u91CD\u8907" : finished ? "\u2713 \u5DF2\u5B8C\u6210 \xB7 \u4EF2\u5DEE HK$ 0.00" : `\u5F85\u5B8C\u6210 \xB7 \u4EF2\u5DEE HK$ ${signedFmt(difference)}`;
    document.getElementById("saveOpeningInvoice").disabled = !canSave;
    return canSave;
  }
  function renderOpeningInvoiceRows() {
    const box = document.getElementById("openingInvoiceRows");
    box.innerHTML = store.openingInvoiceDraft.map((item, i) => `<div class="invoice-editor-row" data-index="${i}"><input class="invoice-date" type="date" aria-label="\u767C\u7968\u65E5\u671F" value="${esc(item.date)}"><input class="invoice-number" aria-label="\u767C\u7968\u7DE8\u865F" autocomplete="off" value="${esc(item.invoiceNo)}" placeholder="\u4F8B\u5982 INV-240401"><input class="invoice-amount" type="number" min="0.01" step="0.01" inputmode="decimal" aria-label="\u767C\u7968\u91D1\u984D" value="${item.amount ? fromCents(item.amount) : ""}" placeholder="0.00"><button class="icon-btn remove-opening-invoice" type="button" aria-label="\u522A\u9664\u6B64\u767C\u7968">\xD7</button></div>`).join("") || '<div class="empty">\u5C1A\u672A\u62C6\u5206\u767C\u7968\u660E\u7D30</div>';
    box.querySelectorAll(".invoice-editor-row").forEach((row, i) => {
      const sync = () => {
        store.openingInvoiceDraft[i] = { date: row.querySelector(".invoice-date").value, invoiceNo: row.querySelector(".invoice-number").value, amount: toCents(row.querySelector(".invoice-amount").value) };
        validateOpeningInvoiceDraft();
      };
      row.querySelectorAll("input").forEach((input) => input.addEventListener("input", sync));
      row.querySelector(".remove-opening-invoice").addEventListener("click", () => {
        store.openingInvoiceDraft.splice(i, 1);
        renderOpeningInvoiceRows();
      });
    });
    validateOpeningInvoiceDraft();
  }
  function openOpeningInvoiceEditor(accountName) {
    store.openingInvoiceAccount = accountName;
    const saved = store.openingInvoiceDetails[store.selectedFiscalKey] && store.openingInvoiceDetails[store.selectedFiscalKey][accountName] || [];
    store.openingInvoiceDraft = saved.map((item) => ({ ...item }));
    document.getElementById("openingInvoiceTitle").textContent = (accountName.startsWith("Accounts Receivable of ") ? "\u61C9\u6536\u8CEC\u6B3E" : "\u61C9\u4ED8\u8CEC\u6B3E") + "\u671F\u521D\u672A\u6E05\u767C\u7968\u660E\u7D30";
    document.getElementById("openingInvoiceHelp").textContent = accountName + " \xB7 \u53EF\u66AB\u5B58\u4E26\u7E7C\u7E8C\u65B0\u589E\uFF1B\u5DEE\u984D\u6B78\u96F6\u5F8C\u624D\u4F9D\u767C\u7968\u65E5\u671F\u9032\u884C FIFO \u5C0D\u92B7";
    openingInvoiceModal.hidden = false;
    renderOpeningInvoiceRows();
  }
  function closeOpeningInvoiceEditor() {
    openingInvoiceModal.hidden = true;
    store.openingInvoiceAccount = "";
    store.openingInvoiceDraft = [];
  }

  // web-src/backup.ts
  var backupButton = document.getElementById("backupData");
  var copyBackupButton = document.getElementById("copyBackupData");
  var restoreButton = document.getElementById("restoreData");
  var restoreFileInput = document.getElementById("restoreFile");
  var backupStatus = document.getElementById("backupStatus");
  var restoreModal = document.getElementById("restoreModal");
  var cloneJSON = (value) => JSON.parse(JSON.stringify(value));
  function replaceArray(target, source) {
    target.splice(0, target.length, ...cloneJSON(source || []));
  }
  function replaceObject(target, source) {
    Object.keys(target).forEach((key) => delete target[key]);
    const src = source || {};
    Object.keys(src).forEach((key) => {
      if (!["__proto__", "prototype", "constructor"].includes(key)) target[key] = cloneJSON(src[key]);
    });
  }
  function replaceSet(target, source) {
    target.clear();
    (source || []).forEach((value) => target.add(String(value)));
  }
  function hydrateVoucher(voucher) {
    const plain = { ...cloneJSON(voucher) };
    plain.attachments = normalizeAttachments(plain);
    delete plain.supportingFile;
    delete plain.supportingName;
    delete plain.supportingAttachment;
    return plain;
  }
  function captureWorkingVoucher() {
    const no = document.getElementById("voucherNoInput").value.trim();
    if (!no && !store.rows.length) return null;
    return { no, type: store.currentType, numberManual: store.numberManuallyEdited, date: document.getElementById("voucherDate").value, desc: document.getElementById("voucherDesc").value, allocationInvoice: document.getElementById("allocationInvoice").value.trim(), madeBy: document.getElementById("madeBy").value.trim(), checkedBy: document.getElementById("checkedBy").value.trim(), approvedBy: document.getElementById("approvedBy").value.trim(), attachments: store.currentAttachments.map((item) => ({ ...item })), lines: store.rows.map((line) => ({ ...line })) };
  }
  async function createBackupPayload() {
    const working = captureWorkingVoucher();
    return { backupFormat: "toys-gallery-accounting", schemaVersion: 2, appVersion: APP_VERSION, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), data: {
      vouchers: await Promise.all(store.vouchers.map(serializeVoucher)),
      accounts: cloneJSON(store.accounts),
      salesInvoices: cloneJSON(store.salesInvoices),
      purchaseInvoices: cloneJSON(store.purchaseInvoices),
      invoiceRemarks: cloneJSON(store.invoiceRemarks),
      allocations: cloneJSON(store.allocations),
      allocationReview: cloneJSON(store.allocationReview),
      fiscalYears: cloneJSON(store.fiscalYears),
      deletedDataYears: [...store.deletedDataYears],
      balanceAdjustments: cloneJSON(store.balanceAdjustments),
      openingBalances: cloneJSON(store.openingBalances),
      openingInvoiceDetails: cloneJSON(store.openingInvoiceDetails),
      reconciliationConfirmations: cloneJSON(store.reconciliationConfirmations),
      staffNames: [...store.staffNames],
      suppressedStaffNames: [...store.suppressedStaffNames],
      settings: { selectedFiscalKey: store.selectedFiscalKey, lastVoucherDates: cloneJSON(store.lastVoucherDates), reportState: cloneJSON(store.reportState), report: store.report, currentRoute: (document.querySelector(".view.active") || {}).id || "dashboard", editingIndex: store.editingIndex },
      workingVoucher: working ? await serializeVoucher(working) : null
    } };
  }
  function validateBackup(payload) {
    if (!payload || payload.backupFormat !== "toys-gallery-accounting" || ![1, 2].includes(Number(payload.schemaVersion)) || !payload.data) throw new Error("\u9019\u4E0D\u662F\u6709\u6548\u7684 Toys Gallery JSON \u5099\u4EFD\u6A94\u3002");
    const data = payload.data;
    if (!Array.isArray(data.accounts) || !data.accounts.length || !data.accounts.every((a) => a && String(a.code || "").trim() && String(a.name || "").trim() && ["\u8CC7\u7522", "\u8CA0\u50B5", "\u6B0A\u76CA", "\u6536\u5165", "\u6210\u672C", "\u8CBB\u7528"].includes(a.type))) throw new Error("\u5099\u4EFD\u5167\u7684\u79D1\u76EE\u8868\u4E0D\u5B8C\u6574\u3002");
    if (!Array.isArray(data.vouchers) || !data.vouchers.every((v) => v && String(v.no || "").trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(v.date || "")) && Array.isArray(v.lines) && v.lines.length >= 2)) throw new Error("\u5099\u4EFD\u5167\u7684 Voucher \u8CC7\u6599\u4E0D\u5B8C\u6574\u3002");
    const voucherNos = data.vouchers.map((v) => String(v.no).toLowerCase());
    if (new Set(voucherNos).size !== voucherNos.length) throw new Error("\u5099\u4EFD\u5167\u6709\u91CD\u8907\u7684 Voucher number\u3002");
    if (!Array.isArray(data.fiscalYears) || !data.fiscalYears.length || !data.fiscalYears.every((fy) => Number.isInteger(Number(fy.start)) && Number(fy.start) >= 2e3 && Number(fy.start) <= 2099)) throw new Error("\u5099\u4EFD\u5167\u7684\u8CA1\u5E74\u8CC7\u6599\u4E0D\u6B63\u78BA\u3002");
    ["salesInvoices", "purchaseInvoices", "allocations", "allocationReview", "staffNames", "suppressedStaffNames"].forEach((key) => {
      if (data[key] !== void 0 && !Array.isArray(data[key])) throw new Error("\u5099\u4EFD\u6B04\u4F4D " + key + " \u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
    });
    return data;
  }
  async function prepareRestore(payload) {
    const data = validateBackup(payload), prepared = { ...data };
    const legacyConverted = Number(payload.schemaVersion) === 1 ? convertLegacyMoneyToCents(prepared) : 0;
    prepared.vouchers = data.vouchers.map(hydrateVoucher);
    prepared.workingVoucher = data.workingVoucher ? hydrateVoucher(data.workingVoucher) : null;
    prepared.fiscalYears = data.fiscalYears.map((fy) => makeFiscalYear(Number(fy.start))).filter((fy, i, list) => list.findIndex((item) => item.key === fy.key) === i).sort((a, b) => b.start - a.start);
    return { prepared, legacyConverted };
  }
  function restoreSummaryHTML(payload, prepared) {
    const when = payload.exportedAt ? new Date(payload.exportedAt).toLocaleString("zh-HK", { dateStyle: "medium", timeStyle: "short" }) : "\u672A\u63D0\u4F9B", fileName = store.pendingRestore ? store.pendingRestore.fileName : "JSON \u5099\u4EFD", converted = store.pendingRestore && store.pendingRestore.legacyConverted || 0;
    return `<p>\u5DF2\u8B80\u53D6 <strong>${esc(fileName)}</strong>\uFF0C\u8ACB\u6838\u5C0D\u5167\u5BB9\u3002</p><div class="restore-summary"><span>\u5099\u4EFD\u7248\u672C <b>v${esc(payload.appVersion || "\u672A\u77E5")}</b></span><span>\u532F\u51FA\u6642\u9593 <b>${esc(when)}</b></span><span>Voucher <b>${prepared.vouchers.length}</b> \u5F35 \xB7 \u79D1\u76EE <b>${prepared.accounts.length}</b> \u500B \xB7 \u8CA1\u5E74 <b>${prepared.fiscalYears.length}</b> \u500B</span></div>${converted ? `<div class="modal-warning">\u820A\u7248\u5099\u4EFD\uFF08schema v1\uFF09\uFF1A\u5DF2\u5C07 ${converted} \u500B\u91D1\u984D\u6B04\u4F4D\u7531\u7F8E\u5143\u8F49\u70BA\u5206\uFF08\u56DB\u6368\u4E94\u5165\u5230\u5206\uFF09\uFF0C\u820A\u6578\u64DA\u7121\u907A\u5931\u3002</div>` : ""}<div class="modal-warning">\u9084\u539F\u6703\u8986\u84CB\u800C\u5BB6\u8A18\u61B6\u9AD4\u5165\u9762\u7684\u5168\u90E8\u8CC7\u6599\u3002\u5B8C\u6210\u5F8C\u8ACB\u91CD\u65B0\u4E0B\u8F09\u4E00\u4EFD\u65B0\u5099\u4EFD\u3002</div><p>\u7B2C\u4E00\u6B21\u78BA\u8A8D\uFF1A\u6309\u300C\u7E7C\u7E8C\u300D\u67E5\u770B\u6700\u5F8C\u78BA\u8A8D\u3002</p>`;
  }
  function renderRestoreModal() {
    const body = document.getElementById("restoreModalBody"), button = document.getElementById("confirmRestore");
    document.getElementById("restoreMessage").textContent = "";
    if (!store.pendingRestore) return;
    if (store.restoreStep === 1) {
      body.innerHTML = restoreSummaryHTML(store.pendingRestore.payload, store.pendingRestore.prepared);
      button.textContent = "\u7E7C\u7E8C";
      button.className = "btn danger";
    } else {
      body.innerHTML = '<div class="modal-warning">\u7B2C\u4E8C\u6B21\u78BA\u8A8D\uFF1A\u78BA\u5B9A\u7528\u6240\u9078 JSON \u5099\u4EFD\u8986\u84CB\u76EE\u524D\u5168\u90E8 Voucher\u3001\u79D1\u76EE\u3001\u671F\u521D\u6578\u3001\u767C\u7968\u3001\u6838\u5C0D\u8A18\u9304\u3001\u8CA1\u5E74\u53CA\u8A2D\u5B9A\uFF1F</div><p>\u6B64\u52D5\u4F5C\u53EA\u6539\u8B8A\u4ECA\u6B21\u958B\u555F\u671F\u9593\u7684\u8A18\u61B6\u9AD4\u8CC7\u6599\uFF0C\u5B8C\u6210\u5F8C\u4E0D\u80FD\u5728\u9801\u5167\u5FA9\u539F\u3002</p>';
      button.textContent = "\u78BA\u8A8D\u9084\u539F";
      button.className = "btn danger";
    }
  }
  function closeRestore() {
    restoreModal.hidden = true;
    store.pendingRestore = null;
    store.restoreStep = 1;
    restoreFileInput.value = "";
  }
  function applyPreparedRestore(data) {
    replaceArray(store.accounts, data.accounts);
    sortAccounts();
    store.vouchers.splice(0, store.vouchers.length, ...data.vouchers.map((voucher) => ({ ...voucher, lines: voucher.lines.map((line) => ({ ...line })) })));
    replaceArray(store.salesInvoices, data.salesInvoices || []);
    replaceArray(store.purchaseInvoices, data.purchaseInvoices || []);
    replaceObject(store.invoiceRemarks, data.invoiceRemarks || {});
    replaceArray(store.allocations, data.allocations || []);
    replaceArray(store.allocationReview, data.allocationReview || []);
    replaceObject(store.balanceAdjustments, data.balanceAdjustments || {});
    replaceObject(store.openingBalances, data.openingBalances || {});
    replaceObject(store.openingInvoiceDetails, data.openingInvoiceDetails || {});
    replaceObject(store.reconciliationConfirmations, data.reconciliationConfirmations || {});
    replaceSet(store.deletedDataYears, data.deletedDataYears || []);
    replaceSet(store.staffNames, data.staffNames || []);
    replaceSet(store.suppressedStaffNames, data.suppressedStaffNames || []);
    replaceObject(store.lastVoucherDates, data.settings && data.settings.lastVoucherDates || {});
    store.fiscalYears = data.fiscalYears;
    store.selectedFiscalKey = data.settings && store.fiscalYears.some((fy) => fy.key === String(data.settings.selectedFiscalKey)) ? String(data.settings.selectedFiscalKey) : store.fiscalYears[0].key;
    replaceObject(store.reportState, data.settings && data.settings.reportState || { month: null, date: "", nameQuery: "", invoiceQuery: "" });
    if (typeof store.reportState.month === "string") store.reportState.month = store.reportState.month === "all" ? null : { key: store.reportState.month };
    store.report = reportNames[data.settings && data.settings.report] ? data.settings.report : "trial";
    document.querySelectorAll("[data-report]").forEach((button) => button.classList.toggle("active", button.dataset.report === store.report));
    closeDeleteFiscal();
    closeAccountEdit();
    closeOpeningInvoiceEditor();
    closeReconciliation();
    toggleFiscalManager(false);
    toggleOpeningManager(false);
    toggleStaffManager(false);
    renderStaffNames();
    refreshFiscalScope();
    const savedIndex = Number(data.settings && data.settings.editingIndex), restoreIndex = Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < store.vouchers.length ? savedIndex : null;
    if (data.workingVoucher) setVoucher(data.workingVoucher, restoreIndex, true);
    const route = ["dashboard", "voucher", "ledger", "reports", "accounts"].includes(data.settings && data.settings.currentRoute) ? data.settings.currentRoute : "dashboard";
    navigate(route);
    renderInvoiceNumberList();
    renderVoucherList();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
  }

  // web-src/main.ts
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearLoginError();
    const submit = loginForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const validUser = loginUser.value.trim() === "admin", validPassword = await hashLoginPassword(loginPassword.value);
      if (!validUser || validPassword !== authorizedPasswordHash) {
        loginError.classList.add("show");
        loginUser.setAttribute("aria-invalid", "true");
        loginPassword.setAttribute("aria-invalid", "true");
        loginPassword.select();
        return;
      }
      document.body.classList.add("authenticated");
      loginPassword.value = "";
      document.querySelector(".view.active h1")?.focus();
    } catch (error) {
      loginError.textContent = "\u66AB\u6642\u672A\u80FD\u9A57\u8B49\u767B\u5165\u8CC7\u6599\uFF0C\u8ACB\u91CD\u65B0\u8F09\u5165\u5F8C\u518D\u8A66\u3002";
      loginError.classList.add("show");
    } finally {
      submit.disabled = false;
    }
  });
  [loginUser, loginPassword].forEach((input) => input.addEventListener("input", clearLoginError));
  sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed")));
  sortAccounts();
  store.salesInvoices.forEach((r) => {
    const match = (store.invoiceRemarks[r[1]] || "").match(/paid on ([A-Za-z]{3}) (\d{4})/i);
    if (match) store.allocations.push({ kind: "AR", invoiceNo: r[1], party: r[2], date: match[2] + "-" + monthNumber[match[1].toLowerCase()], amount: r[3], voucher: "Sales Report \u5099\u8A3B", source: "\u4F86\u6E90\u5099\u8A3B\uFF08\u53EA\u63D0\u4F9B\u6708\u4EFD\uFF09" });
  });
  document.querySelectorAll("[data-route]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.route)));
  renderInvoiceNumberList();
  document.getElementById("closeAttachmentModal").addEventListener("click", closeAttachmentList);
  document.getElementById("attachmentModal").addEventListener("click", (event) => {
    if (event.target.id === "attachmentModal") closeAttachmentList();
  });
  ["madeBy", "checkedBy", "approvedBy"].forEach((id) => document.getElementById(id).addEventListener("input", validate));
  document.getElementById("voucherNoInput").addEventListener("input", (e) => {
    store.numberManuallyEdited = true;
    document.getElementById("voucherNo").textContent = e.target.value.trim() || "\u2014";
    validate();
  });
  document.getElementById("voucherSearch").addEventListener("input", renderVoucherList);
  document.getElementById("addRow").addEventListener("click", () => {
    store.rows.push({ account: store.accounts[0].name, detail: "", debit: 0, credit: 0 });
    renderRows();
  });
  document.getElementById("voucherDate").addEventListener("change", (e) => {
    if (e.target.value && dateInFiscalYear2(e.target.value)) store.lastVoucherDates[store.selectedFiscalKey] = e.target.value;
    genNumber();
  });
  document.querySelectorAll("[data-vtype]").forEach((b) => b.addEventListener("click", () => {
    store.currentType = b.dataset.vtype;
    document.querySelectorAll("[data-vtype]").forEach((x) => x.classList.toggle("active", x === b));
    document.getElementById("voucherTitle").textContent = store.currentType === "B" ? "BANK VOUCHER" : "TRANSFER VOUCHER";
    genNumber();
  }));
  document.getElementById("voucherFile").addEventListener("change", async (event) => {
    const files = [...event.target.files || []];
    if (!files.length) return;
    const box = document.getElementById("attachmentList");
    box.innerHTML = '<div class="muted" style="font-size:11px">\u6B63\u5728\u8B80\u53D6\u9644\u4EF6\u2026</div>';
    try {
      const added = await Promise.all(files.map(fileToAttachment));
      store.currentAttachments.push(...added);
      renderCurrentAttachments();
    } catch (error) {
      renderCurrentAttachments();
      const note = document.createElement("div");
      note.className = "form-message";
      note.textContent = error.message;
      box.appendChild(note);
    }
  });
  manageStaffNames.addEventListener("click", () => toggleStaffManager(staffManager.hidden));
  document.getElementById("closeStaffManager").addEventListener("click", () => toggleStaffManager(false));
  document.getElementById("loadBank").addEventListener("click", () => setVoucher(store.vouchers[0], 0, true));
  document.getElementById("loadTransfer").addEventListener("click", () => setVoucher(store.vouchers[1], 1, true));
  document.getElementById("newVoucher").addEventListener("click", createNewVoucher);
  document.getElementById("postBtn").addEventListener("click", () => {
    if (voucherNumberError()) return validate();
    const v = { no: document.getElementById("voucherNoInput").value.trim(), type: store.currentType, numberManual: store.numberManuallyEdited, date: document.getElementById("voucherDate").value, desc: document.getElementById("voucherDesc").value || "\u2014", allocationInvoice: document.getElementById("allocationInvoice").value.trim(), madeBy: document.getElementById("madeBy").value.trim(), checkedBy: document.getElementById("checkedBy").value.trim(), approvedBy: document.getElementById("approvedBy").value.trim(), attachments: store.currentAttachments.map((item) => ({ ...item })), lines: store.rows.map((x) => ({ ...x })) };
    const wasEditing = store.editingIndex !== null, savedIndex = wasEditing ? store.editingIndex : store.vouchers.length, old = wasEditing ? store.vouchers[savedIndex] : null;
    if (old) {
      applyVoucherBalance(old, -1);
      clearVoucherAllocations(old.no);
      store.vouchers[savedIndex] = v;
    } else store.vouchers.push(v);
    store.editingIndex = savedIndex;
    applyVoucherBalance(v, 1);
    store.lastVoucherDates[fiscalYearForDate(v.date).key] = v.date;
    [v.madeBy, v.checkedBy, v.approvedBy].forEach((name) => {
      if (name && !store.suppressedStaffNames.has(name)) store.staffNames.add(name);
    });
    renderStaffNames();
    const needsReview = applyAllocation2(v);
    document.getElementById("ledgerCount").textContent = String(store.vouchers.filter((item) => dateInFiscalYear2(item.date)).length);
    renderVoucherList();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
    setVoucher(v, savedIndex, true);
    const toast = document.getElementById("postToast");
    toast.textContent = needsReview ? "\u26A0 " + v.no + " \u5DF2" + (wasEditing ? "\u91CD\u65B0" : "") + "\u904E\u8CEC\uFF1B\u5C0D\u92B7\u5DEE\u984D\u6A19\u793A\u70BA\u300C\u5F85\u6838\u5C0D\u300D\uFF0C\u7CFB\u7D71\u672A\u5EFA\u7ACB\u593E\u6578\u79D1\u76EE\u3002" : "\u2713 " + v.no + " \u5DF2" + (wasEditing ? "\u5132\u5B58\u4FEE\u6539\u3001\u91CD\u65B0" : "") + "\u904E\u8CEC\u53CA\u5B8C\u6210\u767C\u7968\u5C0D\u92B7\uFF1B\u5DF2\u505C\u7559\u5728\u672C\u5F35 Voucher\uFF0CLedger \u53CA\u5831\u8868\u5DF2\u66F4\u65B0\u3002";
    toast.style.color = needsReview ? "var(--warn)" : "var(--good)";
    toast.classList.add("show");
  });
  document.getElementById("ledgerAccount").addEventListener("change", renderLedger);
  document.querySelectorAll("[data-report]").forEach((b) => b.addEventListener("click", () => {
    store.report = b.dataset.report;
    document.querySelectorAll("[data-report]").forEach((x) => x.classList.toggle("active", x === b));
    renderReport();
  }));
  showAccountForm.addEventListener("click", () => toggleAccountForm(accountForm.hidden));
  document.getElementById("newAccountType").addEventListener("change", () => updateAccountCodeGuide(true));
  document.getElementById("cancelAccountForm").addEventListener("click", () => toggleAccountForm(false));
  accountForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = document.getElementById("newAccountCode").value.trim(), name = document.getElementById("newAccountName").value.trim(), type = document.getElementById("newAccountType").value;
    let error = "";
    if (!code || !name || !type) error = "\u8ACB\u586B\u5BEB\u79D1\u76EE\u7DE8\u865F\u3001\u79D1\u76EE\u540D\u7A31\u53CA\u985E\u5225\u3002";
    else if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(code)) error = "\u79D1\u76EE\u7DE8\u865F\u53EA\u53EF\u7528\u82F1\u6587\u5B57\u6BCD\u3001\u6578\u5B57\u53CA\u9023\u5B57\u865F\uFF0C\u6700\u591A 20 \u500B\u5B57\u5143\u3002";
    else if (store.accounts.some((a) => a.code.toLowerCase() === code.toLowerCase())) error = "\u6B64\u79D1\u76EE\u7DE8\u865F\u5DF2\u5B58\u5728\uFF0C\u8ACB\u4F7F\u7528\u53E6\u4E00\u500B\u7DE8\u865F\u3002";
    else if (store.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) error = "\u6B64\u79D1\u76EE\u540D\u7A31\u5DF2\u5B58\u5728\uFF0C\u8ACB\u4F7F\u7528\u53E6\u4E00\u500B\u540D\u7A31\u3002";
    if (error) {
      accountFormMessage.textContent = error;
      accountFormMessage.className = "form-message";
      return;
    }
    const side = type === "\u8CC7\u7522" || type === "\u8CBB\u7528" || type === "\u6210\u672C" ? "dr" : "cr";
    store.accounts.push({ code, name, type, balance: 0, importedBalance: 0, side, custom: true, createdFiscalKey: store.selectedFiscalKey });
    accountForm.reset();
    updateAccountCodeGuide();
    accountFormMessage.textContent = `\u2713 \u5DF2\u65B0\u589E ${code} \xB7 ${name}\uFF0C\u53EF\u5373\u6642\u7528\u65BC Voucher\u3001General Ledger \u53CA\u76F8\u95DC\u5831\u8868\u3002`;
    accountFormMessage.className = "form-message success";
    accountsChanged();
    document.getElementById("newAccountCode").focus();
  });
  document.getElementById("accountSearch").addEventListener("input", renderAccounts);
  document.getElementById("accountType").addEventListener("change", renderAccounts);
  manageOpeningBalances.addEventListener("click", () => toggleOpeningManager(openingManager.hidden));
  document.getElementById("closeOpeningManager").addEventListener("click", () => toggleOpeningManager(false));
  document.getElementById("saveOpeningBalances").addEventListener("click", () => {
    if (!validateOpeningBalances()) return;
    const fy = selectedFiscalYear();
    store.openingBalances[fy.key] = readOpeningDraft();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
    const state = document.getElementById("openingBalanceState");
    state.className = "opening-status ok";
    state.textContent = `\u2713 ${fy.label} \u671F\u521D\u6578\u5DF2\u5132\u5B58\uFF0CLedger \u53CA\u5831\u8868\u5DF2\u66F4\u65B0`;
  });
  document.getElementById("fiscalYearSelect").addEventListener("change", (e) => {
    store.selectedFiscalKey = e.target.value;
    refreshFiscalScope();
  });
  manageFiscalYears.addEventListener("click", () => toggleFiscalManager(fiscalManager.hidden));
  document.getElementById("closeFiscalManager").addEventListener("click", () => toggleFiscalManager(false));
  document.getElementById("fiscalYearForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("fiscalStartYear"), message = document.getElementById("fiscalFormMessage"), start = Number(input.value);
    message.className = "form-message";
    if (!Number.isInteger(start) || start < 2e3 || start > 2099) {
      message.textContent = "\u8ACB\u8F38\u5165 2000 \u81F3 2099 \u4E4B\u9593\u7684\u958B\u59CB\u5E74\u4EFD\u3002";
      return;
    }
    if (store.fiscalYears.some((fy2) => fy2.start === start)) {
      message.textContent = `FY${start}/${String(start + 1).slice(-2)} \u5DF2\u5B58\u5728\u3002`;
      return;
    }
    const fy = makeFiscalYear(start);
    store.fiscalYears.push(fy);
    store.fiscalYears.sort((a, b) => b.start - a.start);
    store.selectedFiscalKey = fy.key;
    input.value = "";
    message.textContent = `\u2713 \u5DF2\u65B0\u589E\u4E26\u5207\u63DB\u81F3 ${fy.label}\u3002`;
    message.className = "form-message success";
    refreshFiscalScope();
    toggleFiscalManager(false);
    toggleOpeningManager(true);
  });
  document.getElementById("cancelDeleteFiscal").addEventListener("click", closeDeleteFiscal);
  document.getElementById("deleteFiscalModal").addEventListener("click", (e) => {
    if (e.target.id === "deleteFiscalModal") closeDeleteFiscal();
  });
  document.getElementById("confirmDeleteFiscal").addEventListener("click", () => {
    if (!store.deleteFiscalCandidate) return;
    if (store.deleteFiscalStep === 1) {
      store.deleteFiscalStep = 2;
      renderDeleteFiscal();
      return;
    }
    const fy = store.deleteFiscalCandidate, removedNos = new Set(store.vouchers.filter((v) => dateInFiscalYear2(v.date, fy)).map((v) => v.no));
    for (let i = store.vouchers.length - 1; i >= 0; i--) if (dateInFiscalYear2(store.vouchers[i].date, fy)) store.vouchers.splice(i, 1);
    for (let i = store.salesInvoices.length - 1; i >= 0; i--) if (dateInFiscalYear2(store.salesInvoices[i][0], fy)) store.salesInvoices.splice(i, 1);
    for (let i = store.purchaseInvoices.length - 1; i >= 0; i--) if (dateInFiscalYear2(store.purchaseInvoices[i][0], fy)) store.purchaseInvoices.splice(i, 1);
    for (let i = store.allocations.length - 1; i >= 0; i--) if (removedNos.has(store.allocations[i].voucher) || dateInFiscalYear2(store.allocations[i].date, fy)) store.allocations.splice(i, 1);
    for (let i = store.allocationReview.length - 1; i >= 0; i--) if (removedNos.has(store.allocationReview[i].voucher)) store.allocationReview.splice(i, 1);
    delete store.balanceAdjustments[fy.key];
    delete store.openingBalances[fy.key];
    delete store.openingInvoiceDetails[fy.key];
    store.deletedDataYears.add(fy.key);
    store.fiscalYears = store.fiscalYears.filter((x) => x.key !== fy.key);
    if (store.selectedFiscalKey === fy.key) store.selectedFiscalKey = store.fiscalYears[0].key;
    closeDeleteFiscal();
    refreshFiscalScope();
  });
  document.getElementById("saveAccountEdit").addEventListener("click", () => {
    if (!store.editingAccount) return;
    const name = document.getElementById("editAccountName").value.trim(), type = document.getElementById("editAccountType").value, message = document.getElementById("accountEditMessage");
    message.className = "form-message";
    if (!name || !type) {
      message.textContent = "\u8ACB\u586B\u5BEB\u79D1\u76EE\u540D\u7A31\u53CA\u985E\u5225\u3002";
      return;
    }
    if (store.accounts.some((a) => a !== store.editingAccount && a.name.toLowerCase() === name.toLowerCase())) {
      message.textContent = "\u6B64\u79D1\u76EE\u540D\u7A31\u5DF2\u5B58\u5728\uFF0C\u8ACB\u4F7F\u7528\u53E6\u4E00\u500B\u540D\u7A31\u3002";
      return;
    }
    if (name === store.editingAccount.name && type === store.editingAccount.type) {
      closeAccountEdit();
      return;
    }
    if (store.accountEditStep === 1 && accountHasEntries(store.editingAccount)) {
      store.accountEditStep = 2;
      const warning = document.getElementById("accountEditWarning");
      warning.hidden = false;
      warning.textContent = "\u6B64\u79D1\u76EE\u5DF2\u6709\u532F\u5165\u7D50\u9918\u3001\u671F\u521D\u6578\u6216 Voucher \u5206\u9304\u3002\u78BA\u8A8D\u5F8C\uFF0C\u73FE\u6709\u5206\u9304\u6703\u4FDD\u7559\u4E26\u8F49\u7528\u65B0\u540D\u7A31\uFF0F\u985E\u5225\uFF0C\u6240\u6709\u5831\u8868\u4F4D\u7F6E\u6703\u5373\u6642\u66F4\u65B0\u3002";
      document.getElementById("saveAccountEdit").textContent = "\u78BA\u8A8D\u4E26\u66F4\u65B0\u6240\u6709\u5831\u8868";
      return;
    }
    applyAccountEdit();
  });
  document.getElementById("cancelAccountEdit").addEventListener("click", closeAccountEdit);
  accountEditModal.addEventListener("click", (e) => {
    if (e.target === accountEditModal) closeAccountEdit();
  });
  ["editAccountName", "editAccountType"].forEach((id) => document.getElementById(id).addEventListener("input", () => {
    if (store.accountEditStep === 2) {
      store.accountEditStep = 1;
      document.getElementById("accountEditWarning").hidden = true;
      document.getElementById("saveAccountEdit").textContent = "\u5132\u5B58\u4FEE\u6539";
    }
  }));
  document.getElementById("cancelDeleteAccount").addEventListener("click", closeDeleteAccount);
  deleteAccountModal.addEventListener("click", (event) => {
    if (event.target === deleteAccountModal) closeDeleteAccount();
  });
  document.getElementById("confirmDeleteAccount").addEventListener("click", () => {
    if (!store.deletingAccount) return;
    if (store.deleteAccountUsage.length) {
      closeDeleteAccount();
      return;
    }
    if (store.deleteAccountStep === 1) {
      store.deleteAccountStep = 2;
      renderDeleteAccount();
      return;
    }
    const code = store.deletingAccount.code, name = store.deletingAccount.name, index = store.accounts.indexOf(store.deletingAccount);
    if (index >= 0) store.accounts.splice(index, 1);
    [store.openingBalances, store.openingInvoiceDetails, store.balanceAdjustments].forEach((store2) => Object.values(store2).forEach((year) => {
      if (year) delete year[name];
    }));
    closeDeleteAccount();
    updateAccountCodeGuide();
    renderInvoiceNumberList();
    accountsChanged();
    accountFormMessage.textContent = `\u2713 \u5DF2\u522A\u9664 ${code} \xB7 ${name}\uFF0CVoucher \u79D1\u76EE\u641C\u5C0B\u3001Ledger \u53CA\u5831\u8868\u5DF2\u66F4\u65B0\u3002`;
    accountFormMessage.className = "form-message success";
  });
  document.getElementById("addOpeningInvoice").addEventListener("click", () => {
    store.openingInvoiceDraft.push({ date: selectedFiscalYear().from, invoiceNo: "", amount: 0 });
    renderOpeningInvoiceRows();
    const rows = document.querySelectorAll(".invoice-editor-row");
    if (rows.length) rows[rows.length - 1].querySelector(".invoice-number").focus();
  });
  document.getElementById("saveOpeningInvoice").addEventListener("click", () => {
    var _a, _b;
    if (!validateOpeningInvoiceDraft()) return;
    const accountName = store.openingInvoiceAccount, count = store.openingInvoiceDraft.length;
    (_a = store.openingInvoiceDetails)[_b = store.selectedFiscalKey] ?? (_a[_b] = {});
    if (count) store.openingInvoiceDetails[store.selectedFiscalKey][accountName] = store.openingInvoiceDraft.map((item) => ({ ...item, invoiceNo: item.invoiceNo.trim() }));
    else delete store.openingInvoiceDetails[store.selectedFiscalKey][accountName];
    closeOpeningInvoiceEditor();
    const row = [...document.querySelectorAll("#openingBalanceBody tr[data-account]")].find((el) => el.dataset.account === accountName), button = row && row.querySelector(".opening-detail-btn");
    if (button) button.textContent = count ? "\u4FEE\u6539 " + count + " \u5F35" : "\uFF0B \u62C6\u5206\u767C\u7968";
    validateOpeningBalances();
    renderInvoiceNumberList();
    renderReport();
  });
  document.getElementById("cancelOpeningInvoice").addEventListener("click", closeOpeningInvoiceEditor);
  openingInvoiceModal.addEventListener("click", (e) => {
    if (e.target === openingInvoiceModal) closeOpeningInvoiceEditor();
  });
  document.getElementById("addReconcileInvoice").addEventListener("click", () => {
    if (!store.reconciliationContext) return;
    const fy = selectedFiscalYear(), date = store.reconciliationContext.month === null ? fy.from : store.reconciliationContext.month.key + "-01";
    store.reconcileInvoiceDraft.push({ date, invoiceNo: "", amount: 0, origin: "invoice" });
    renderReconcileDraft();
    const inputs = document.querySelectorAll(".recon-invoice-no");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  document.getElementById("addReconcilePayment").addEventListener("click", () => {
    if (!store.reconcileInvoiceDraft.length) {
      const message = document.getElementById("reconcileMessage");
      message.textContent = "\u8ACB\u5148\u65B0\u589E\u767C\u7968\uFF0C\u6536\uFF0F\u4ED8\u6B3E\u8A18\u9304\u9700\u8981\u9078\u64C7\u5C0D\u92B7\u767C\u7968\u3002";
      message.className = "form-message";
      return;
    }
    const date = store.reconciliationContext.month === null ? selectedFiscalYear().from : store.reconciliationContext.month.key + "-01";
    store.reconcilePaymentDraft.push({ date, voucher: "", invoiceNo: store.reconcileInvoiceDraft[0].invoiceNo, amount: 0, source: "\u4EBA\u5DE5\u8A18\u9304" });
    renderReconcileDraft();
    const inputs = document.querySelectorAll(".recon-payment-voucher");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  document.getElementById("saveReconcileRecords").addEventListener("click", () => {
    if (saveReconcileRecords()) updateReconcileSummary();
  });
  document.getElementById("confirmReconcile").addEventListener("click", () => {
    if (!store.reconciliationContext) return;
    const confirmedBy = document.getElementById("reconcileConfirmedBy").value.trim(), date = document.getElementById("reconcileConfirmedDate").value, note = document.getElementById("reconcileNote").value.trim(), message = document.getElementById("reconcileMessage");
    if (!confirmedBy || !date) {
      message.textContent = "\u8ACB\u586B\u5BEB\u78BA\u8A8D\u4EBA\u53CA\u78BA\u8A8D\u65E5\u671F\u3002";
      message.className = "form-message";
      return;
    }
    if (!saveReconcileRecords()) return;
    const metrics = reconcileDraftMetrics(), key = reconcileKey(store.reconciliationContext.kind, store.reconciliationContext.party, store.reconciliationContext.month);
    store.reconciliationConfirmations[key] = { confirmedBy, date, note, invoiceOutstanding: metrics.invoiceOutstanding, accountBalance: metrics.accountBalance, difference: metrics.difference };
    renderReport();
    closeReconciliation();
  });
  document.getElementById("cancelReconcile").addEventListener("click", closeReconciliation);
  reconcileModal.addEventListener("click", (e) => {
    if (e.target === reconcileModal) closeReconciliation();
  });
  backupButton.addEventListener("click", async () => {
    backupButton.disabled = true;
    copyBackupButton.disabled = true;
    backupStatus.textContent = "\u6B63\u5728\u6574\u7406\u5168\u90E8\u8CC7\u6599\u53CA\u9644\u4EF6\u2026";
    try {
      const payload = await createBackupPayload(), stamp = payload.exportedAt.slice(0, 19).replace(/[:T]/g, "-"), blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }), filename = `Toys-Gallery-backup-v${APP_VERSION}-${stamp}.json`, opened = openDownloadPopup(blob, filename, "\u5099\u4EFD\u6A94\u4E0B\u8F09");
      backupStatus.textContent = opened ? `\u5DF2\u958B\u65B0\u8996\u7A97\uFF0C\u8ACB\u55BA\u65B0\u8996\u7A97\u64B3\u300C\u64B3\u5462\u5EA6\u4E0B\u8F09\u300D\u5B8C\u6210\u4E0B\u8F09 \xB7 ${store.vouchers.length} \u5F35 Voucher` : "\u700F\u89BD\u5668\u963B\u64CB\u5497\u65B0\u8996\u7A97\uFF0C\u8ACB\u7528\u65C1\u908A\u7684\u300C\u8907\u88FD\u5099\u4EFD\u5167\u5BB9\u300D\u63A3";
    } catch (error) {
      backupStatus.textContent = "\u5099\u4EFD\u5931\u6557\uFF1A" + error.message;
    } finally {
      backupButton.disabled = false;
      copyBackupButton.disabled = false;
    }
  });
  copyBackupButton.addEventListener("click", async () => {
    backupButton.disabled = true;
    copyBackupButton.disabled = true;
    backupStatus.textContent = "\u6B63\u5728\u6574\u7406\u5168\u90E8\u8CC7\u6599\u53CA\u9644\u4EF6\u2026";
    try {
      const payload = await createBackupPayload();
      backupStatus.textContent = "\u6B63\u5728\u8907\u88FD\u5B8C\u6574 JSON \u5099\u4EFD\u2026";
      await copyTextToClipboard(JSON.stringify(payload, null, 2), backupStatus);
    } catch (error) {
      backupStatus.textContent = "\u8907\u88FD\u5099\u4EFD\u5931\u6557\uFF1A" + error.message;
    } finally {
      backupButton.disabled = false;
      copyBackupButton.disabled = false;
    }
  });
  restoreButton.addEventListener("click", () => {
    restoreFileInput.value = "";
    restoreFileInput.click();
  });
  restoreFileInput.addEventListener("change", async () => {
    const file = (restoreFileInput.files || [])[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      backupStatus.textContent = "\u9084\u539F\u5931\u6557\uFF1AJSON \u5099\u4EFD\u8D85\u904E 100 MB\u3002";
      restoreFileInput.value = "";
      return;
    }
    restoreButton.disabled = true;
    backupStatus.textContent = "\u6B63\u5728\u6AA2\u67E5\u5099\u4EFD\u6A94\u2026";
    try {
      const payload = JSON.parse(await file.text()), { prepared, legacyConverted } = await prepareRestore(payload);
      store.pendingRestore = { fileName: file.name, payload, prepared, legacyConverted };
      store.restoreStep = 1;
      renderRestoreModal();
      restoreModal.hidden = false;
      document.getElementById("confirmRestore").focus();
      backupStatus.textContent = "\u5099\u4EFD\u6A94\u5DF2\u9A57\u8B49\uFF0C\u7B49\u5F85\u4E8C\u6B21\u78BA\u8A8D";
    } catch (error) {
      backupStatus.textContent = "\u9084\u539F\u5931\u6557\uFF1A" + error.message;
      restoreFileInput.value = "";
    } finally {
      restoreButton.disabled = false;
    }
  });
  document.getElementById("cancelRestore").addEventListener("click", closeRestore);
  restoreModal.addEventListener("click", (event) => {
    if (event.target === restoreModal) closeRestore();
  });
  document.getElementById("confirmRestore").addEventListener("click", () => {
    if (!store.pendingRestore) return;
    if (store.restoreStep === 1) {
      store.restoreStep = 2;
      renderRestoreModal();
      return;
    }
    try {
      const count = store.pendingRestore.prepared.vouchers.length;
      applyPreparedRestore(store.pendingRestore.prepared);
      closeRestore();
      backupStatus.textContent = `\u2713 \u5DF2\u9084\u539F ${count} \u5F35 Voucher\uFF1B\u8ACB\u7ACB\u5373\u4E0B\u8F09\u65B0\u5099\u4EFD`;
    } catch (error) {
      document.getElementById("restoreMessage").textContent = "\u9084\u539F\u5931\u6557\uFF1A" + error.message;
    }
  });
  renderStaffNames();
  renderFiscalYears();
  refreshFiscalScope();

  // desktop/excel-rows.ts
  var dollars = (cents) => cents / 100;
  function buildReportRows(key) {
    const prevReport = store.report;
    store.report = key;
    try {
      let rows;
      if (key === "sales" || key === "purchase") {
        const isPurchase = key === "purchase";
        const source = reportTransactionRows(isPurchase).filter(
          (r) => (store.reportState.month === null || r.date.slice(0, 7) === store.reportState.month.key) && (!store.reportState.nameQuery || String(r.name).toLowerCase().includes(store.reportState.nameQuery.toLowerCase())) && (!store.reportState.invoiceQuery || String(r.invoice).toLowerCase().includes(store.reportState.invoiceQuery.toLowerCase()))
        );
        rows = isPurchase ? [
          ["Date", "Invoice number", "Voucher Number", "Name", "Amount", "Remark"],
          ...source.map(
            (r) => [
              r.date,
              r.invoice,
              r.voucherText,
              r.name,
              dollars(r.amount),
              r.remark
            ]
          )
        ] : [
          [
            "Channel",
            "Date",
            "Invoice number",
            "Voucher Number",
            "Name",
            "Amount",
            "Remark"
          ],
          ...source.sort(
            (a, b) => salesChannels.findIndex((c) => c.key === salesChannel(a)) - salesChannels.findIndex((c) => c.key === salesChannel(b)) || a.name.localeCompare(b.name) || a.date.localeCompare(b.date)
          ).map(
            (r) => [
              (salesChannels.find((c) => c.key === salesChannel(r)) || {}).label || "",
              r.date,
              r.invoice,
              r.voucherText,
              r.name,
              dollars(r.amount),
              r.remark
            ]
          )
        ];
      } else if (key === "ar" || key === "ap") {
        const kind = key === "ar" ? "AR" : "AP";
        const parties = store.accounts.filter(
          (a) => a.name.startsWith(
            key === "ar" ? "Accounts Receivable of " : "Accounts Payable of "
          )
        ).map((a) => a.name.replace(/^Accounts (Receivable|Payable) of /, ""));
        const seenInv = /* @__PURE__ */ new Set();
        const source = parties.flatMap((p) => invoiceMatches(kind, p)).filter((r) => {
          const k = r[0] + "|" + String(r[1] || "").trim().toLowerCase();
          if (seenInv.has(k)) return false;
          seenInv.add(k);
          return true;
        });
        rows = [
          [
            "Date",
            "Invoice number",
            "Voucher Number",
            key === "ar" ? "Customer" : "Supplier",
            "Invoice amount",
            "Paid",
            "Outstanding"
          ],
          ...source.filter(
            (r) => (r[4] === "opening" || dateInFiscalYear2(r[0])) && (store.reportState.month === null || r[0].slice(0, 7) === store.reportState.month.key)
          ).map((r) => {
            const paid = allocatedTotal(kind, r[1]);
            return [
              r[0],
              r[1],
              invoiceVoucherText(kind, r[1], r[4]),
              r[2],
              dollars(r[3]),
              dollars(paid),
              dollars(Math.max(0, r[3] - paid))
            ];
          })
        ];
      } else if (key === "journal") {
        rows = [
          ["Date", "Voucher No.", "Account", "Particulars", "Debit", "Credit"],
          ...store.vouchers.filter(
            (v) => dateInFiscalYear2(v.date) && (store.reportState.month === null || v.date.slice(0, 7) === store.reportState.month.key)
          ).flatMap(
            (v) => v.lines.map((line, lineIndex) => ({
              date: v.date,
              no: v.no,
              account: line.account,
              particulars: line.detail || v.desc,
              debit: line.debit,
              credit: line.credit,
              lineIndex
            }))
          ).sort(
            (a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no) || a.lineIndex - b.lineIndex
          ).map(
            (row) => [
              row.date,
              row.no,
              row.account,
              row.particulars,
              row.debit ? dollars(row.debit) : "",
              row.credit ? dollars(row.credit) : ""
            ]
          )
        ];
      } else if (key === "register") {
        rows = [
          [
            "Date",
            "Voucher",
            "Type",
            "Description",
            "Amount",
            "Made by",
            "Checked by",
            "Approved by"
          ],
          ...store.vouchers.filter(
            (v) => dateInFiscalYear2(v.date) && (store.reportState.month === null || v.date.slice(0, 7) === store.reportState.month.key)
          ).map(
            (v) => [
              v.date,
              v.no,
              v.type,
              v.desc,
              dollars(v.lines.reduce((s, l) => s + l.debit, 0)),
              v.madeBy || "",
              v.checkedBy || "",
              v.approvedBy || ""
            ]
          )
        ];
      } else {
        rows = [
          ["Account", "Debit", "Credit"],
          ...fiscalAccounts().filter((a) => accountSignedBalance(a)).map((a) => {
            const signed = accountSignedBalance(a);
            return [
              a.name,
              signed > 0 ? dollars(signed) : "",
              signed < 0 ? dollars(Math.abs(signed)) : ""
            ];
          })
        ];
      }
      return rows;
    } finally {
      store.report = prevReport;
    }
  }

  // desktop/xlsx-polish.ts
  function sheetFileMap(workbookXml, relsXml) {
    const relMap = /* @__PURE__ */ new Map();
    const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"|<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g;
    let m;
    while (m = relRe.exec(relsXml)) {
      const id = m[1] || m[4];
      const target = m[2] || m[3];
      if (id && target) relMap.set(id, target.replace(/^.*\//, ""));
    }
    const out = /* @__PURE__ */ new Map();
    const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"|<sheet[^>]*r:id="([^"]+)"[^>]*name="([^"]+)"/g;
    while (m = sheetRe.exec(workbookXml)) {
      const name = (m[1] || m[4] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const rid = m[2] || m[3];
      const file = relMap.get(rid);
      if (name && file) out.set(name, "xl/worksheets/" + file);
    }
    return out;
  }
  function injectFreezePane(sheetXml, freezeRows) {
    if (freezeRows <= 0) return sheetXml;
    const topLeft = "A" + (freezeRows + 1);
    const pane = '<pane ySplit="' + freezeRows + '" topLeftCell="' + topLeft + '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="' + topLeft + '" sqref="' + topLeft + '"/>';
    if (/<sheetView[^>]*\/>/.test(sheetXml)) {
      return sheetXml.replace(
        /<sheetView([^>]*)\/>/,
        "<sheetView$1>" + pane + "</sheetView>"
      );
    }
    if (/<sheetView([^>]*)>/.test(sheetXml)) {
      return sheetXml.replace(/(<sheetView[^>]*>)/, "$1" + pane);
    }
    return sheetXml;
  }
  function boldRowCells(sheetXml, boldRows, xfId) {
    let out = sheetXml;
    for (const r0 of boldRows) {
      const r = r0 + 1;
      const rowRe = new RegExp('(<row[^>]*\\br="' + r + '"[^>]*>)([\\s\\S]*?)(</row>)');
      out = out.replace(rowRe, (_all, open, inner, close) => {
        const patched = inner.replace(/<c(\s[^>]*)?>/g, (cm) => {
          if (/\bs="/.test(cm)) return cm;
          return cm.replace(/>$/, ' s="' + xfId + '">');
        });
        return open + patched + close;
      });
    }
    return out;
  }
  function addBoldStyle(stylesXml) {
    const fontCount = (stylesXml.match(/<font>/g) || []).length;
    const xfCount = (stylesXml.match(/<xf /g) || []).length;
    const firstFont = stylesXml.match(/<font>[\s\S]*?<\/font>/);
    const baseFont = firstFont ? firstFont[0] : '<font><sz val="11"/><name val="Calibri"/></font>';
    const boldFont = baseFont.replace("</font>", "<b/></font>");
    const newFontXml = boldFont;
    let xml = stylesXml.replace(/(<\/fonts>)/, newFontXml + "$1");
    xml = xml.replace(/(<fonts[^>]*count=")\d+(")/, "$1" + (fontCount + 1) + "$2");
    const newXf = '<xf numFmtId="0" fontId="' + fontCount + '" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
    xml = xml.replace(/(<\/cellXfs>)/, newXf + "$1");
    xml = xml.replace(/(<cellXfs[^>]*count=")\d+(")/, "$1" + (xfCount + 1) + "$2");
    return { xml, xfId: xfCount };
  }
  function addPrintTitles(workbookXml, sheetIdx, sheetName, titleRows) {
    const quoted = "'" + sheetName.replace(/'/g, "''") + "'";
    const entry = '<definedName name="_xlnm.Print_Titles" localSheetId="' + sheetIdx + '">' + quoted + "!$" + titleRows.replace(":", ":$") + "</definedName>";
    if (/<definedNames>/.test(workbookXml)) {
      return workbookXml.replace(/(<\/definedNames>)/, () => entry + "</definedNames>");
    }
    return workbookXml.replace(/(<\/workbook>)/, () => "<definedNames>" + entry + "</definedNames></workbook>");
  }
  async function polishXlsx(xlsxBytes, sheets, JSZip) {
    const zip = await JSZip.loadAsync(xlsxBytes);
    const workbookXml = await zip.file("xl/workbook.xml").async("string");
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    const fileMap = sheetFileMap(workbookXml, relsXml);
    const sheetOrder = [];
    const orderRe = /<sheet[^>]*name="([^"]+)"/g;
    let om;
    while (om = orderRe.exec(workbookXml)) {
      sheetOrder.push(
        om[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      );
    }
    let newWorkbookXml = workbookXml;
    let stylesPatched = null;
    for (const opt of sheets) {
      const file = fileMap.get(opt.name);
      if (!file || !zip.file(file)) continue;
      let sheetXml = await zip.file(file).async("string");
      sheetXml = injectFreezePane(sheetXml, opt.freezeRows);
      if (opt.boldRows && opt.boldRows.length) {
        if (!stylesPatched) {
          const stylesXml = await zip.file("xl/styles.xml").async("string");
          stylesPatched = addBoldStyle(stylesXml);
          zip.file("xl/styles.xml", stylesPatched.xml);
        }
        sheetXml = boldRowCells(sheetXml, opt.boldRows, stylesPatched.xfId);
      }
      zip.file(file, sheetXml);
      if (opt.titleRows) {
        const idx = sheetOrder.indexOf(opt.name);
        if (idx >= 0) {
          newWorkbookXml = addPrintTitles(newWorkbookXml, idx, opt.name, opt.titleRows);
        }
      }
    }
    if (newWorkbookXml !== workbookXml) zip.file("xl/workbook.xml", newWorkbookXml);
    const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return out;
  }

  // desktop/excel-vouchers.ts
  var VOUCHER_TEMPLATE_HEADERS = [
    "\u65E5\u671F Date",
    "Voucher No.\uFF08\u5409=\u81EA\u52D5\u7DE8\u865F\uFF09",
    "\u985E\u578B Type\uFF08B=\u9280\u884C / T=\u8F49\u8CEC\uFF09",
    "\u6458\u8981 Description",
    "\u501F\u65B9\u79D1\u76EE Debit Account",
    "\u501F\u65B9\u91D1\u984D Debit Amount",
    "\u8CB8\u65B9\u79D1\u76EE Credit Account",
    "\u8CB8\u65B9\u91D1\u984D Credit Amount",
    "\u660E\u7D30 Detail",
    "\u88FD\u8868 Made By",
    "\u8986\u6838 Checked By",
    "\u6279\u6838 Approved By",
    "\u9644\u4EF6 Attachment\uFF08\u6A94\u540D\uFF0C\u591A\u500B\u7528 ; \u5206\u9694\uFF09",
    "\u5C0D\u92B7\u767C\u7968\u865F Allocation Invoice\uFF08\u5409=FIFO\u81EA\u52D5\u5C0D\u92B7\uFF09"
  ];
  function buildVoucherTemplateHelp() {
    return [
      ["Toys Gallery \u6703\u8A08\u7CFB\u7D71 \u2014 Voucher \u6279\u91CF\u532F\u5165\u8AAA\u660E\uFF08\u684C\u9762\u7248\u7368\u6709\uFF09"],
      [""],
      ["1. \u300C\u7BC4\u672C\u300Dsheet \u6BCF\u884C = \u4E00\u689D\u5206\u9304\u884C\uFF1B\u540C\u4E00\u5F35 voucher \u5605\u884C\uFF0CB \u6B04\u586B\u540C\u4E00\u500B Voucher No.\u3002"],
      ["2. B \u6B04\u5409\u5514\u586B = \u81EA\u52D5\u7DE8\u865F\uFF08B040124 \u683C\u5F0F\uFF1A\u985E\u578B+\u6708\u4EFD+\u5E8F\u865F+\u5E74\u4EFD\uFF09\uFF1B\u5409\u6B04\u5605\u884C\u6703\u6309\u300C\u9023\u7E8C\uFF0B\u65E5\u671F\uFF0F\u985E\u578B\uFF0F\u6458\u8981\u76F8\u540C\u300D\u81EA\u52D5\u4F75\u505A\u4E00\u5F35 voucher\u3002"],
      ["3. C \u6B04\u985E\u578B\u586B B\uFF08\u9280\u884C\uFF09\u6216 T\uFF08\u8F49\u8CEC\uFF09\uFF0C\u4E5F\u53EF\u586B\u300C\u9280\u884C\u300D\uFF0F\u300C\u8F49\u8CEC\u300D\u3002"],
      ["4. \u6BCF\u884C\u53EA\u53EF\u4EE5\u586B\u501F\u65B9\u6216\u8CB8\u65B9\u5176\u4E2D\u4E00\u908A\uFF1B\u4E00\u5F35 voucher \u5605\u501F\u65B9\u7E3D\u984D\u5FC5\u9808\u7B49\u65BC\u8CB8\u65B9\u7E3D\u984D\u3002"],
      ["5. \u79D1\u76EE\u586B\u7DE8\u865F\u6216\u540D\u7A31\uFF08\u5FC5\u9808\u5DF2\u55BA\u7CFB\u7D71\u5B58\u5728\uFF09\u3002\u91D1\u984D\u586B\u7F8E\u5143\u6578\u5B57\uFF08\u4F8B\u5982 1999.99\uFF09\u3002"],
      ["6. \u65E5\u671F\u683C\u5F0F YYYY-MM-DD\uFF0C\u4E14\u5FC5\u9808\u5C6C\u65BC\u5DF2\u55BA\u7CFB\u7D71\u958B\u5497\u5605\u8CA1\u5E74\u3002"],
      ["7. \u88FD\u8868\uFF0F\u8986\u6838\uFF0F\u6279\u6838\u4E09\u500B\u90FD\u8981\u586B\uFF08\u540C\u7CFB\u7D71\u5165\u8CEC\u898F\u5247\u4E00\u81F4\uFF09\u3002"],
      ["8. M \u6B04\u300C\u9644\u4EF6\u300D\uFF1A\u586B\u9644\u4EF6\u6A94\u540D\uFF0C\u591A\u500B\u7528 ; \u5206\u9694\uFF08\u4F8B\uFF1Areceipt1.pdf;receipt2.jpg\uFF09\u3002"],
      ["   \u532F\u5165\u6642\u5C07 Excel\uFF0B\u9644\u4EF6\u653E\u55BA\u540C\u4E00\u500B\u8CC7\u6599\u593E\uFF0C\u7CFB\u7D71\u6703\u81EA\u52D5\u55BA\u8CC7\u6599\u593E\u5167\u6435\u5C0D\u61C9\u6A94\u6848\u3002"],
      ["9. N \u6B04\u300C\u5C0D\u92B7\u767C\u7968\u865F\u300D\uFF1A\u6536\u6B3E\uFF0F\u4ED8\u6B3E\u8981\u5C0D\u6307\u5B9A\u767C\u7968\u5C31\u586B\u767C\u7968\u865F\uFF1B\u5409\u5C31\u6309 FIFO\uFF08\u6700\u820A\u5148\uFF09\u81EA\u52D5\u5C0D\u92B7\u3002"],
      ["10. \u7B2C\u4E00\u884C\u4FC2\u6A19\u984C\u5217\uFF0C\u8ACB\u4FDD\u7559\uFF1B\u4E0B\u9762\u5605\u793A\u4F8B\u884C\u8ACB\u522A\u9664\u5F8C\u518D\u586B\u3002"],
      ["11. \u532F\u5165\u6642\u6703\u9010\u884C\u9A57\u8B49\uFF0C\u6709\u932F\u5605\u884C\u6703\u5217\u51FA\uFF0C\u53EF\u63C0\u300C\u53EA\u532F\u5165\u6709\u6548\u884C\u300D\u3002"]
    ];
  }
  function buildVoucherTemplateExample() {
    return [
      VOUCHER_TEMPLATE_HEADERS,
      // 示例 voucher 1：指定編號，兩行，有附件，對銷指定發票
      ["2024-04-05", "B040124", "B", "\u6536\u5230 Toy Hunters \u8CA8\u6B3E", "Bank Saving Account", 5e3, "", "", "INV2024040026", "\u963FBin", "\u963FMay", "\u8001\u95C6", "receipt1.pdf;receipt2.jpg", "INV2024040026"],
      ["2024-04-05", "B040124", "B", "\u6536\u5230 Toy Hunters \u8CA8\u6B3E", "", "", "Accounts Receivable of Toy Hunters", 5e3, "INV2024040026", "\u963FBin", "\u963FMay", "\u8001\u95C6", "", "INV2024040026"],
      // 示例 voucher 2：吉編號（自動），兩行，FIFO
      ["2024-04-06", "", "T", "\u4ED8\u4F9B\u61C9\u5546\u8A02\u91D1", "Prepayment to Supplier", 1200.5, "", "", "", "\u963FBin", "\u963FMay", "\u8001\u95C6", "", ""],
      ["2024-04-06", "", "T", "\u4ED8\u4F9B\u61C9\u5546\u8A02\u91D1", "", "", "Bank Saving Account", 1200.5, "", "\u963FBin", "\u963FMay", "\u8001\u95C6", "", ""]
    ];
  }
  function cellStr(v) {
    if (v === void 0 || v === null) return "";
    return String(v).trim();
  }
  function normType(raw) {
    const t = raw.trim().toLowerCase();
    if (t === "b" || t === "\u9280\u884C" || t === "bank") return "B";
    if (t === "t" || t === "\u8F49\u8CEC" || t === "\u8F6C\u8D26" || t === "transfer") return "T";
    return null;
  }
  function isValidDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = /* @__PURE__ */ new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function nextVoucherNumberFor(date, type, taken) {
    const yy = date.slice(2, 4);
    const mm = date.slice(5, 7);
    if (!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm)) return "";
    const pattern = new RegExp("^" + type + mm + "(\\d{2})" + yy + "$", "i");
    let max = 0;
    taken.forEach((no2) => {
      const m = String(no2).match(pattern);
      if (m) max = Math.max(max, Number(m[1]) || 0);
    });
    let seq = max + 1;
    let no = "";
    do {
      no = type + mm + String(seq++).padStart(2, "0") + yy;
    } while (taken.has(no.toLowerCase()));
    taken.add(no.toLowerCase());
    return no;
  }
  function parseVoucherImport(allRows) {
    const errors = [];
    const drafts = [];
    if (!allRows.length) return { drafts, errors, validDrafts: [] };
    let hi = -1;
    for (let i = 0; i < Math.min(allRows.length, 10); i++) {
      const r = (allRows[i] || []).map(cellStr).join("|");
      if (/日期/.test(r) && /借方科目/.test(r)) {
        hi = i;
        break;
      }
    }
    if (hi < 0) {
      errors.push({ rowNum: 0, message: "\u6435\u5514\u5230\u6A19\u984C\u884C\uFF08\u8981\u6709\u300C\u65E5\u671F\u300D\u300C\u501F\u65B9\u79D1\u76EE\u300D\u6B04\uFF09\u3002\u8ACB\u7528\u7BC4\u672C\u4E0B\u8F09\u5605\u6A94\u6848\u3002" });
      return { drafts, errors, validDrafts: [] };
    }
    const fyKeys = new Set(store.fiscalYears.map((f) => f.key));
    const existingNos = new Set(store.vouchers.map((v) => String(v.no).toLowerCase()));
    const draftByKey = /* @__PURE__ */ new Map();
    let autoGroup = 0;
    const getDraft = (rowNum, voucherNo, date, type, desc, madeBy, checkedBy, approvedBy, attachmentPaths, allocationInvoice) => {
      let key;
      if (voucherNo) {
        key = "no:" + voucherNo.toLowerCase();
      } else {
        const prev = drafts[drafts.length - 1];
        if (prev && !prev.voucherNo && prev.date === date && prev.type === type && prev.desc === desc && prev.rowNums[prev.rowNums.length - 1] === rowNum - 1) {
          return prev;
        }
        autoGroup++;
        key = "auto:" + autoGroup;
      }
      let d = draftByKey.get(key);
      if (!d) {
        d = {
          key,
          voucherNo,
          date,
          type,
          desc,
          madeBy,
          checkedBy,
          approvedBy,
          lines: [],
          rowNums: [],
          attachmentPaths: [...attachmentPaths],
          allocationInvoice
        };
        draftByKey.set(key, d);
        drafts.push(d);
      } else {
        if (d.date !== date || d.type !== type) {
          errors.push({ rowNum, message: "\u540C\u4E00 Voucher No. \u5605\u65E5\u671F\uFF0F\u985E\u578B\u5514\u4E00\u81F4\uFF08" + d.date + "/" + d.type + " vs " + date + "/" + type + "\uFF09\u3002" });
          return null;
        }
        if (d.allocationInvoice !== allocationInvoice) {
          errors.push({ rowNum, message: "\u540C\u4E00 Voucher No. \u5605\u5C0D\u92B7\u767C\u7968\u865F\u5514\u4E00\u81F4\uFF08" + (d.allocationInvoice || "\uFF08\u5409\uFF09") + " vs " + (allocationInvoice || "\uFF08\u5409\uFF09") + "\uFF09\u3002" });
          return null;
        }
        for (const p of attachmentPaths) {
          if (p && !d.attachmentPaths.includes(p)) d.attachmentPaths.push(p);
        }
      }
      return d;
    };
    for (let i = hi + 1; i < allRows.length; i++) {
      const rowNum = i + 1;
      const r = allRows[i] || [];
      if (r.every((c2) => cellStr(c2) === "")) continue;
      const c = (idx) => cellStr(r[idx]);
      const date = c(0), voucherNo = c(1), typeRaw = c(2), desc = c(3) || "\u2014";
      const drAcctRaw = c(4), drAmtRaw = cellStr(r[5]);
      const crAcctRaw = c(6), crAmtRaw = cellStr(r[7]);
      const detail = c(8), madeBy = c(9), checkedBy = c(10), approvedBy = c(11);
      const attachmentPaths = c(12).split(/[;；\n\r]+/).map((s) => s.trim()).filter(Boolean);
      const allocationInvoice = c(13).trim();
      let rowOk = true;
      const err = (msg) => {
        errors.push({ rowNum, message: msg });
        rowOk = false;
      };
      if (!isValidDateStr(date)) {
        err("\u65E5\u671F\u683C\u5F0F\u5514\u5571\uFF08\u8981 YYYY-MM-DD\uFF09\uFF1A" + (date || "\uFF08\u5409\uFF09"));
        continue;
      }
      const fyKey = fiscalYearForDate(date).key;
      if (!fyKeys.has(fyKey)) {
        err("\u65E5\u671F " + date + " \u5514\u5C6C\u65BC\u4EFB\u4F55\u5DF2\u958B\u7ACB\u5605\u8CA1\u5E74\uFF0C\u8ACB\u5148\u65B0\u589E\u8CA1\u5E74\u3002");
        continue;
      }
      const type = normType(typeRaw);
      if (!type) {
        err("\u985E\u578B\u5514\u5571\uFF08\u8981 B=\u9280\u884C / T=\u8F49\u8CEC\uFF09\uFF1A" + (typeRaw || "\uFF08\u5409\uFF09"));
        continue;
      }
      if (voucherNo) {
        if (existingNos.has(voucherNo.toLowerCase())) err("Voucher No. \u5DF2\u5B58\u5728\uFF1A" + voucherNo);
      }
      if (!madeBy || !checkedBy || !approvedBy) err("\u88FD\u8868\uFF0F\u8986\u6838\uFF0F\u6279\u6838\u4E09\u500B\u90FD\u8981\u586B\uFF08\u540C\u7CFB\u7D71\u5165\u8CEC\u898F\u5247\u4E00\u81F4\uFF09\u3002");
      const drAmt = drAmtRaw === "" ? 0 : toCents(drAmtRaw);
      const crAmt = crAmtRaw === "" ? 0 : toCents(crAmtRaw);
      const drFilled = drAmtRaw !== "" && drAmt > 0;
      const crFilled = crAmtRaw !== "" && crAmt > 0;
      if (drFilled && crFilled) err("\u4E00\u884C\u53EA\u53EF\u4EE5\u586B\u501F\u65B9\u6216\u8CB8\u65B9\u5176\u4E2D\u4E00\u908A\u3002");
      else if (!drFilled && !crFilled) err("\u8ACB\u586B\u501F\u65B9\u6216\u8CB8\u65B9\u91D1\u984D\uFF08\u5FC5\u9808\u5927\u65BC 0\uFF09\u3002");
      if (drAmtRaw !== "" && drAmt <= 0) err("\u501F\u65B9\u91D1\u984D\u5514\u4FC2\u6709\u6548\u6B63\u6578\uFF1A" + drAmtRaw);
      if (crAmtRaw !== "" && crAmt <= 0) err("\u8CB8\u65B9\u91D1\u984D\u5514\u4FC2\u6709\u6548\u6B63\u6578\uFF1A" + crAmtRaw);
      const acctRaw = drFilled ? drAcctRaw : crAcctRaw;
      const acct = resolveAccount(acctRaw);
      if (!acctRaw) err("\u8ACB\u586B" + (drFilled ? "\u501F\u65B9" : "\u8CB8\u65B9") + "\u79D1\u76EE\u3002");
      else if (!acct) err("\u79D1\u76EE\u5514\u5B58\u5728\uFF1A" + acctRaw + "\uFF08\u586B\u7DE8\u865F\u6216\u540D\u7A31\uFF0C\u5FC5\u9808\u5DF2\u55BA\u7CFB\u7D71\u5B58\u5728\uFF09\u3002");
      if (!rowOk) continue;
      const d = getDraft(rowNum, voucherNo, date, type, desc, madeBy, checkedBy, approvedBy, attachmentPaths, allocationInvoice);
      if (!d) continue;
      d.lines.push({
        account: acct.name,
        debit: drFilled ? drAmt : 0,
        credit: crFilled ? crAmt : 0,
        detail
      });
      d.rowNums.push(rowNum);
    }
    const badDraftKeys = /* @__PURE__ */ new Set();
    errors.forEach((e) => {
      for (const d of drafts) if (d.rowNums.includes(e.rowNum)) badDraftKeys.add(d.key);
    });
    for (const d of drafts) {
      const dr = d.lines.reduce((s, l) => s + l.debit, 0);
      const cr = d.lines.reduce((s, l) => s + l.credit, 0);
      if (d.lines.length === 0) {
        badDraftKeys.add(d.key);
        continue;
      }
      if (!(dr > 0 && dr === cr)) {
        const label = d.voucherNo || "\u81EA\u52D5\u7DE8\u865F\u7D44\uFF08\u7B2C " + d.rowNums[0] + " \u884C\u8D77\uFF09";
        errors.push({ rowNum: d.rowNums[0], message: "\u501F\u8CB8\u4E0D\u5E73\uFF1A\u501F\u65B9 " + fromCents(dr) + " vs \u8CB8\u65B9 " + fromCents(cr) + "\uFF08" + label + "\uFF09\u3002" });
        badDraftKeys.add(d.key);
      }
    }
    const validDrafts = drafts.filter((d) => !badDraftKeys.has(d.key) && d.lines.length > 0);
    return { drafts, errors, validDrafts };
  }
  function importVouchers(drafts) {
    const taken = new Set(store.vouchers.map((v) => String(v.no).toLowerCase()));
    const voucherNos = [];
    const attachmentMap = {};
    let needsReview = 0;
    for (const d of drafts) {
      const no = d.voucherNo || nextVoucherNumberFor(d.date, d.type, taken);
      if (!no) continue;
      const v = {
        no,
        type: d.type,
        numberManual: Boolean(d.voucherNo),
        date: d.date,
        desc: d.desc,
        allocationInvoice: d.allocationInvoice || "",
        madeBy: d.madeBy,
        checkedBy: d.checkedBy,
        approvedBy: d.approvedBy,
        attachments: [],
        lines: d.lines.map((l) => ({
          account: l.account,
          debit: l.debit,
          credit: l.credit,
          detail: l.detail
        }))
      };
      store.vouchers.push(v);
      applyVoucherBalance(v, 1);
      if (applyAllocation2(v)) needsReview++;
      for (const name of [v.madeBy, v.checkedBy, v.approvedBy]) {
        if (name && !store.suppressedStaffNames.has(name)) store.staffNames.add(name);
      }
      try {
        store.lastVoucherDates[fiscalYearForDate(v.date).key] = v.date;
      } catch (e) {
      }
      voucherNos.push(no);
      if (d.attachmentPaths && d.attachmentPaths.length) {
        attachmentMap[no] = d.attachmentPaths;
      }
    }
    renderInvoiceNumberList();
    renderVoucherList();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
    return { imported: voucherNos.length, skipped: drafts.length - voucherNos.length, needsReview, voucherNos, attachmentMap };
  }

  // desktop/excel-export.ts
  var dollars2 = (cents) => cents / 100;
  function inRange(date, fromMonth, toMonth) {
    const ym = date.slice(0, 7);
    if (fromMonth && ym < fromMonth) return false;
    if (toMonth && ym > toMonth) return false;
    return true;
  }
  function buildVoucherExport(fyKey, fromMonth, toMonth) {
    const fy = store.fiscalYears.find((f) => f.key === fyKey) || selectedFiscalYear();
    const vouchers = store.vouchers.filter((v) => dateInFiscalYear2(v.date, fy)).filter((v) => !fromMonth && !toMonth ? true : inRange(v.date, fromMonth, toMonth)).sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));
    const summaryHeader = [
      "Voucher No.",
      "\u985E\u578B",
      "\u65E5\u671F",
      "\u6458\u8981",
      "\u501F\u65B9\u7E3D\u984D",
      "\u8CB8\u65B9\u7E3D\u984D",
      "\u88FD\u8868",
      "\u8986\u6838",
      "\u6279\u6838",
      "\u9644\u4EF6"
    ];
    const detailHeader = [
      "Voucher No.",
      "\u65E5\u671F",
      "\u884C\u865F",
      "\u79D1\u76EE",
      "\u660E\u7D30",
      "\u501F\u65B9",
      "\u8CB8\u65B9"
    ];
    const summary = [summaryHeader];
    const detail = [detailHeader];
    const links = [];
    const attachments = [];
    vouchers.forEach((v, vi) => {
      const dr = v.lines.reduce((s, l) => s + l.debit, 0);
      const cr = v.lines.reduce((s, l) => s + l.credit, 0);
      const atts = Array.isArray(v.attachments) ? v.attachments : [];
      const r = vi + 1;
      const c = 9;
      let attCell = "\u2014";
      if (atts.length) {
        attCell = atts.length + " \u500B\u9644\u4EF6";
        links.push({
          sheet: 0,
          r,
          c,
          target: "attachments/" + v.no + "/",
          tooltip: atts.map((a) => a.name || "").join(", ") || "\u958B\u555F\u9644\u4EF6\u8CC7\u6599\u593E"
        });
        atts.forEach((a) => {
          const ax = a;
          attachments.push({
            voucherNo: v.no,
            name: a.name || "attachment",
            relPath: ax.path || "",
            hasDataURL: typeof ax.dataURL === "string",
            dataURL: typeof ax.dataURL === "string" ? ax.dataURL : ""
          });
        });
      }
      summary.push([
        v.no,
        v.type === "B" ? "\u9280\u884C" : v.type === "T" ? "\u8F49\u8CEC" : v.type,
        v.date,
        v.desc,
        dollars2(dr),
        dollars2(cr),
        v.madeBy || "",
        v.checkedBy || "",
        v.approvedBy || "",
        attCell
      ]);
      v.lines.forEach((l, li) => {
        detail.push([
          v.no,
          v.date,
          li + 1,
          l.account,
          l.detail || "",
          l.debit ? dollars2(l.debit) : "",
          l.credit ? dollars2(l.credit) : ""
        ]);
      });
    });
    const fyLabel = fy.label.replace(/[^A-Za-z0-9\u4e00-\u9fa5-]/g, "-");
    const rangeLabel = fyLabel + (fromMonth || toMonth ? "_" + (fromMonth || "\u958B\u59CB") + "\u81F3" + (toMonth || "\u6700\u5F8C") : "");
    return {
      summary,
      detail,
      links,
      attachments,
      voucherCount: vouchers.length,
      lineCount: detail.length - 1,
      rangeLabel
    };
  }

  // desktop/desktop-entry.ts
  function reportHTML(key) {
    const prev = store.report;
    store.report = key;
    try {
      return reportBody();
    } finally {
      store.report = prev;
    }
  }
  function blankStart() {
    const fy = makeFiscalYear(currentFiscalStart);
    replaceArray(store.vouchers, []);
    replaceArray(store.accounts, []);
    replaceArray(store.salesInvoices, []);
    replaceArray(store.purchaseInvoices, []);
    replaceObject(store.invoiceRemarks, {});
    replaceArray(store.allocations, []);
    replaceArray(store.allocationReview, []);
    replaceObject(store.balanceAdjustments, {});
    replaceObject(store.openingBalances, {});
    replaceObject(store.openingInvoiceDetails, {});
    replaceObject(store.reconciliationConfirmations, {});
    replaceSet(store.deletedDataYears, []);
    replaceSet(store.staffNames, []);
    replaceSet(store.suppressedStaffNames, []);
    replaceObject(store.lastVoucherDates, {});
    replaceObject(store.reportState, {
      month: null,
      date: "",
      nameQuery: "",
      invoiceQuery: ""
    });
    store.fiscalYears = [fy];
    store.selectedFiscalKey = fy.key;
    store.report = "trial";
    store.editingIndex = null;
    navigate("dashboard");
    renderInvoiceNumberList();
    renderVoucherList();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
    renderStaffNames();
  }
  async function beginRestore(payload, fileName) {
    const { prepared, legacyConverted } = await prepareRestore(payload);
    store.pendingRestore = { fileName, payload, prepared, legacyConverted };
    store.restoreStep = 1;
    renderRestoreModal();
    restoreModal.hidden = false;
    document.getElementById("confirmRestore").focus();
  }
  function importExcelData(imp) {
    let addedAccounts = 0;
    let skippedAccounts = 0;
    const have = new Set(store.accounts.map((a) => String(a.code).toLowerCase()));
    for (const a of imp.accounts || []) {
      const code = String(a.code || "").trim();
      const name = String(a.name || "").trim();
      const type = String(a.type || "").trim();
      if (!code || !name || !["\u8CC7\u7522", "\u8CA0\u50B5", "\u6B0A\u76CA", "\u6536\u5165", "\u6210\u672C", "\u8CBB\u7528"].includes(type)) {
        continue;
      }
      if (have.has(code.toLowerCase())) {
        skippedAccounts++;
        continue;
      }
      store.accounts.push({
        code,
        name,
        type,
        balance: 0,
        importedBalance: 0,
        side: type === "\u8CC7\u7522" || type === "\u8CBB\u7528" || type === "\u6210\u672C" ? "dr" : "cr",
        custom: true,
        createdFiscalKey: store.selectedFiscalKey
      });
      have.add(code.toLowerCase());
      addedAccounts++;
    }
    sortAccounts();
    let setOpening = 0;
    let openingErrors = 0;
    for (const r of imp.opening || []) {
      const fy = store.fiscalYears.find((f) => f.key === String(r.fy));
      const acct = fy && store.accounts.find((a) => a.name === String(r.account));
      if (!fy || !acct || !Number.isFinite(Number(r.amount))) {
        openingErrors++;
        continue;
      }
      const cents = dollarsToCents(Number(r.amount));
      const entry = acct.side === "dr" ? { debit: cents, credit: 0 } : { debit: 0, credit: cents };
      store.openingBalances[fy.key] = store.openingBalances[fy.key] || {};
      store.openingBalances[fy.key][String(r.account)] = entry;
      setOpening++;
    }
    let setInvoices = 0;
    let invoiceErrors = 0;
    const invoiceTotals = /* @__PURE__ */ new Map();
    for (const inv of imp.invoices || []) {
      const fyKey = String(inv.fy || "").trim();
      const party = String(inv.party || "").trim();
      const no = String(inv.no || "").trim();
      const date = String(inv.date || "").trim();
      const kind = String(inv.kind || "").trim().toUpperCase();
      const amount = Number(inv.amount);
      const fy = store.fiscalYears.find((f) => f.key === fyKey);
      if (!fy || !party || !no || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0 || kind !== "AR" && kind !== "AP") {
        invoiceErrors++;
        continue;
      }
      const cents = dollarsToCents(amount);
      const row = [date, no, party, cents, "opening"];
      if (kind === "AR") {
        if (!store.salesInvoices.some((x) => x[1] === no)) {
          store.salesInvoices.push(row);
          setInvoices++;
        }
      } else {
        if (!store.purchaseInvoices.some((x) => x[1] === no)) {
          store.purchaseInvoices.push(row);
          setInvoices++;
        }
      }
      const tkey = fyKey + "|" + kind + "|" + party;
      invoiceTotals.set(tkey, (invoiceTotals.get(tkey) || 0) + cents);
    }
    const invoiceMismatch = [];
    for (const [tkey, total] of invoiceTotals) {
      const [fyKey, kind, party] = tkey.split("|");
      const acctName = (kind === "AR" ? "Accounts Receivable of " : "Accounts Payable of ") + party;
      const obRaw = store.openingBalances[fyKey] && store.openingBalances[fyKey][acctName];
      if (!obRaw) {
        invoiceMismatch.push(party + "\uFF08\u7121\u671F\u521D\u6578\uFF09");
        continue;
      }
      const ob = obRaw;
      const obCents = (ob.debit || 0) + (ob.credit || 0);
      if (Math.abs(obCents - total) > 0) {
        invoiceMismatch.push(party + "\uFF08\u767C\u7968 " + (total / 100).toFixed(2) + " vs \u671F\u521D " + (obCents / 100).toFixed(2) + "\uFF09");
      }
    }
    renderAccounts();
    renderReport();
    renderKPIs();
    return { addedAccounts, skippedAccounts, setOpening, openingErrors, setInvoices, invoiceErrors, invoiceMismatch };
  }
  function previewRollover(fromKey) {
    const fromFy = store.fiscalYears.find((f) => f.key === fromKey);
    if (!fromFy) return null;
    const toStart = fromFy.start + 1;
    const toLabel = "FY" + toStart + "/" + String(toStart + 1).slice(-2);
    const accounts = [];
    for (const a of store.accounts) {
      if (!["\u8CC7\u7522", "\u8CA0\u50B5", "\u6B0A\u76CA"].includes(a.type)) continue;
      const bal = accountBalance(a, fromFy);
      if (bal === 0) continue;
      accounts.push({ name: a.name, type: a.type, closing: bal });
    }
    const invoices = [];
    const parties = /* @__PURE__ */ new Set();
    for (const a of store.accounts) {
      let kind = "";
      let party = "";
      if (a.name.startsWith("Accounts Receivable of ")) {
        kind = "AR";
        party = a.name.replace("Accounts Receivable of ", "");
      } else if (a.name.startsWith("Accounts Payable of ")) {
        kind = "AP";
        party = a.name.replace("Accounts Payable of ", "");
      }
      if (!kind) continue;
      parties.add(party);
    }
    const ctx2 = {
      salesInvoices: store.salesInvoices,
      purchaseInvoices: store.purchaseInvoices,
      allocations: store.allocations,
      openingBalances: store.openingBalances,
      vouchers: store.vouchers,
      accounts: store.accounts
    };
    for (const party of parties) {
      for (const kind of ["AR", "AP"]) {
        const acctName = (kind === "AR" ? "Accounts Receivable of " : "Accounts Payable of ") + party;
        if (!store.accounts.some((a) => a.name === acctName)) continue;
        try {
          const invs = invoiceMatches2(kind, party, fromFy, ctx2);
          for (const inv of invs) {
            const total = inv[3];
            const alloc = allocatedTotal2(kind, inv[1], fromFy, store.allocations);
            const out = total - alloc;
            if (out > 0) {
              invoices.push({ kind, party, no: inv[1], date: inv[0], outstanding: out });
            }
          }
        } catch (e) {
        }
      }
    }
    return {
      fromLabel: fromFy.label,
      toLabel,
      accounts,
      invoices,
      invoiceParties: [...parties]
    };
  }
  function executeRollover(fromKey, toKey) {
    const preview = previewRollover(fromKey);
    if (!preview) return { accounts: 0, invoices: 0 };
    const toFy = store.fiscalYears.find((f) => f.key === toKey);
    if (!toFy) return { accounts: 0, invoices: 0 };
    let accCount = 0;
    store.openingBalances[toKey] = store.openingBalances[toKey] || {};
    for (const a of preview.accounts) {
      const acct = store.accounts.find((x) => x.name === a.name);
      if (!acct) continue;
      const entry = acct.side === "dr" ? { debit: a.closing, credit: 0 } : { debit: 0, credit: a.closing };
      store.openingBalances[toKey][a.name] = entry;
      accCount++;
    }
    let invCount = 0;
    for (const inv of preview.invoices) {
      const row = [inv.date, inv.no, inv.party, inv.outstanding, "opening"];
      if (inv.kind === "AR") {
        if (!store.salesInvoices.some((x) => x[1] === inv.no)) {
          store.salesInvoices.push(row);
          invCount++;
        }
      } else {
        if (!store.purchaseInvoices.some((x) => x[1] === inv.no)) {
          store.purchaseInvoices.push(row);
          invCount++;
        }
      }
    }
    renderAccounts();
    renderReport();
    renderKPIs();
    return { accounts: accCount, invoices: invCount };
  }
  var bridge = {
    desktopVersion: "3.26.2",
    createBackupPayload,
    validateBackup,
    prepareRestore,
    applyPreparedRestore,
    buildReportRows,
    reportHTML,
    blankStart,
    beginRestore,
    importExcelData,
    fiscalLabel: () => selectedFiscalYear().label,
    setNativeDownload: (fn) => {
      window.__tgNativeDownload = fn;
    },
    toCents,
    polishWorkbook: (bytes, sheets, JSZip) => polishXlsx(bytes, sheets, JSZip),
    buildVoucherTemplateHelp,
    buildVoucherTemplateExample,
    parseVoucherImport,
    importVouchers,
    nextVoucherNumberFor,
    renderVoucherList,
    previewRollover,
    executeRollover,
    /** v3.25.2：按編號攞 voucher（操作日誌用） */
    getVoucher: (no) => {
      const v = store.vouchers.find((x) => x.no === no);
      return v ? JSON.parse(JSON.stringify(v)) : null;
    },
    /** v3.25.2：刪除 voucher 前嘅資訊（確認 dialog 用） */
    getVoucherDeleteInfo: (no) => {
      const v = store.vouchers.find((x) => x.no === no);
      if (!v) return null;
      return {
        no: v.no,
        date: v.date,
        type: v.type,
        desc: v.desc,
        amountCents: v.lines.reduce((s, l) => s + l.debit, 0),
        attachmentCount: (v.attachments || []).length,
        allocationCount: store.allocations.filter((a) => a.voucher === no).length
      };
    },
    /** v3.25.2：刪除 voucher——反過賬＋清對銷＋移除＋重繪；回傳快照（audit 用） */
    deleteVoucher: (no) => {
      const idx = store.vouchers.findIndex((x) => x.no === no);
      if (idx < 0) return null;
      const v = store.vouchers[idx];
      applyVoucherBalance(v, -1);
      clearVoucherAllocations(v.no);
      const snapshot = JSON.parse(JSON.stringify(v));
      const wasEditing = store.editingIndex === idx;
      store.vouchers.splice(idx, 1);
      if (wasEditing) {
        createNewVoucher();
      } else if (store.editingIndex !== null && store.editingIndex > idx) {
        store.editingIndex--;
      }
      try {
        document.getElementById("ledgerCount").textContent = String(store.vouchers.filter((item) => dateInFiscalYear2(item.date)).length);
      } catch {
      }
      renderVoucherList();
      renderLedger();
      renderReport();
      renderAccounts();
      renderKPIs();
      return snapshot;
    },
    attachmentButtonHTML,
    bindAttachmentButtons,
    openAttachmentList,
    getAccountNames: () => store.accounts.map((a) => a.name),
    setVoucherAttachments: (no, atts) => {
      const v = store.vouchers.find((x) => x.no === no);
      if (!v) return false;
      v.attachments = atts.map((a) => ({ name: a.name, type: a.mime, dataURL: a.dataURL }));
      return true;
    },
    buildVoucherExport,
    fiscalYears: () => store.fiscalYears.map((f) => ({ key: f.key, label: f.label, from: f.from, to: f.to })),
    selectedFiscalKey: () => store.selectedFiscalKey,
    /** 報表月份標籤（''=全年，否則 'YYYY-MM'），xlsx 標題用 */
    reportPeriodLabel: () => {
      const m = store.reportState.month;
      return m && m.key ? String(m.key) : "";
    },
    /** Journal 當前篩選嘅 voucher（供報表匯出附件用） */
    getJournalVouchers: () => {
      const m = store.reportState.month;
      const monthKey = m && m.key ? String(m.key) : null;
      return store.vouchers.filter((v) => {
        try {
          if (!dateInFiscalYear2(v.date)) return false;
        } catch {
          return false;
        }
        if (monthKey && v.date.slice(0, 7) !== monthKey) return false;
        return true;
      }).map((v) => ({
        no: v.no,
        attachments: (v.attachments || []).map((a) => ({
          name: a.name,
          dataURL: a.dataURL,
          dataB64: a.dataB64,
          mime: a.mime || a.type
        }))
      }));
    }
  };
  window.__TG__ = bridge;
  if (APP_VERSION !== "3.15.1") {
    console.error("[desktop] APP_VERSION mismatch:", APP_VERSION);
  }
})();
