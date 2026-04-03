const { Voucher, JournalEntry, VoucherSequence, Account, Party } = require('../../models/accounting');

const PREFIX_MAP = {
  cash_payment:  'CPV',
  cash_receipt:  'CRV',
  bank_payment:  'BPV',
  bank_receipt:  'BRV',
  journal:       'JV',
  card_transfer: 'CT',
};

async function getNextVoucherNumber(tenantId, type) {
  const seq = await VoucherSequence.findOneAndUpdate(
    { tenantId, type },
    { $inc: { lastNumber: 1 } },
    { upsert: true, new: true }
  );
  return `${PREFIX_MAP[type]}-${String(seq.lastNumber).padStart(4, '0')}`;
}

async function peekNextVoucherNumber(tenantId, type) {
  const seq = await VoucherSequence.findOne({ tenantId, type }).lean();
  const next = (seq?.lastNumber || 0) + 1;
  return `${PREFIX_MAP[type]}-${String(next).padStart(4, '0')}`;
}

async function postVoucher(voucherId) {
  const voucher = await Voucher.findById(voucherId);
  if (!voucher || voucher.status !== 'draft') throw new Error('Cannot post: voucher is not in draft status');

  const journalEntries = voucher.lines.map((line) => ({
    tenantId:      voucher.tenantId,
    voucherId:     voucher._id,
    voucherNumber: voucher.voucherNumber,
    voucherType:   voucher.type,
    accountId:     line.accountId,
    accountName:   line.accountName,
    partyId:       line.partyId || null,
    partyName:     line.partyName || null,
    debit:         line.debit,
    credit:        line.credit,
    date:          voucher.date,
    description:   line.description,
    autoPosted:    voucher.autoPosted,
  }));

  // Debug: log ALL journal entries about to be inserted
  console.log(`[PostVoucher] ${voucher.voucherNumber}: inserting ${journalEntries.length} journal entries:`);
  journalEntries.forEach((e, i) => {
    console.log(`  [${i}] accountId=${e.accountId} | accountName=${e.accountName} | partyId=${e.partyId || 'none'} | partyName=${e.partyName || 'none'} | dr=${e.debit} | cr=${e.credit}`);
  });

  await JournalEntry.insertMany(journalEntries);
  await Voucher.findByIdAndUpdate(voucherId, { status: 'posted' });
}

async function createVoucher({ tenantId, type, date, referenceNo, notes, lines, autoPosted = false, sourceId = null, createdBy }) {
  if (!lines || lines.length < 2) throw new Error('Minimum 2 lines required');

  const totalDebit  = lines.reduce((s, l) => s + (Number(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Debits (${totalDebit}) must equal credits (${totalCredit})`);
  }

  lines.forEach((l, i) => {
    const d = Number(l.debit) || 0;
    const c = Number(l.credit) || 0;
    if (d > 0 && c > 0) throw new Error(`Line ${i + 1}: cannot have both debit and credit`);
    if (d === 0 && c === 0) throw new Error(`Line ${i + 1}: must have a non-zero amount`);
  });

  const voucherNumber = await getNextVoucherNumber(tenantId, type);

  // Denormalise account and party names
  const accountIds = [...new Set(lines.map((l) => l.accountId).filter(Boolean))];
  const partyIds   = [...new Set(lines.map((l) => l.partyId).filter(Boolean))];

  const [accounts, parties] = await Promise.all([
    Account.find({ _id: { $in: accountIds } }).lean(),
    Party.find(  { _id: { $in: partyIds   } }).lean(),
  ]);

  const accountMap = Object.fromEntries(accounts.map((a) => [a._id.toString(), a.name]));
  const partyMap   = Object.fromEntries(parties.map( (p) => [p._id.toString(), p.name]));

  // Debug: log every incoming line before enrichment
  console.log(`\n[CreateVoucher] Incoming lines (${lines.length}):`);
  lines.forEach((l, i) => {
    console.log(`  [${i}] accountId=${l.accountId} | partyId=${l.partyId || 'none'} | dr=${l.debit || 0} | cr=${l.credit || 0}`);
  });
  console.log(`[CreateVoucher] accountMap keys: ${Object.keys(accountMap).join(', ')}`);

  const enrichedLines = lines.map((l, i) => ({
    ...l,
    debit:       Number(l.debit)  || 0,
    credit:      Number(l.credit) || 0,
    accountName: accountMap[l.accountId?.toString()] || l.accountName || '',
    partyName:   partyMap[l.partyId?.toString()]   || l.partyName   || '',
    sequence:    i,
  }));

  // Debug: log every enriched line going into the voucher
  console.log(`[CreateVoucher] Enriched lines:`);
  enrichedLines.forEach((l, i) => {
    console.log(`  [${i}] accountId=${l.accountId} | accountName=${l.accountName} | partyId=${l.partyId || 'none'} | partyName=${l.partyName || 'none'} | dr=${l.debit} | cr=${l.credit}`);
  });

  const voucher = await Voucher.create({
    tenantId, type, voucherNumber, date, referenceNo, notes,
    totalAmount: totalDebit,
    autoPosted, sourceId, createdBy,
    status: 'draft',
    lines: enrichedLines,
  });

  await postVoucher(voucher._id);
  return Voucher.findById(voucher._id);
}

module.exports = { createVoucher, postVoucher, getNextVoucherNumber, peekNextVoucherNumber };
