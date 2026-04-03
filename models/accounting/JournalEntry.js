const mongoose = require('mongoose');

const journalEntrySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', required: true },
    voucherNumber: { type: String },
    voucherType: { type: String },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    accountCode: { type: String },
    accountName: { type: String },
    partyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', default: null },
    partyName: { type: String },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    date: { type: Date, required: true },
    description: { type: String },
    autoPosted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

journalEntrySchema.index({ tenantId: 1, accountId: 1, date: 1 });
journalEntrySchema.index({ tenantId: 1, partyId: 1, date: 1 });
journalEntrySchema.index({ tenantId: 1, voucherId: 1 });
journalEntrySchema.index({ tenantId: 1, date: 1 });

const JournalEntry = mongoose.model('JournalEntry', journalEntrySchema);

module.exports = JournalEntry;
