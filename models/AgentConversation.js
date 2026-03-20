const mongoose = require('mongoose');

const agentConversationSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    channel: {
      type: String,
      enum: ['chat', 'voice'],
      default: 'chat',
      index: true,
    },
    sessionId: { type: String, required: true, index: true },
    slug: { type: String, index: true },
    messages: [
      {
        role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
        content: { type: String, default: '' },
        at: { type: Date, default: Date.now },
      },
    ],
    meta: {
      userAgent: String,
      ip: String,
    },
  },
  { timestamps: true }
);

agentConversationSchema.index({ restaurant: 1, updatedAt: -1 });

module.exports = mongoose.model('AgentConversation', agentConversationSchema);
