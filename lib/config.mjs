// One place for names and model choices. Model ids are Workers AI catalog
// names; check https://developers.cloudflare.com/workers-ai/models/ if one
// is retired.
export const CONFIG = {
  d1Name: 'reed',
  index: 'reed-filings',
  embedModel: '@cf/baai/bge-base-en-v1.5',
  dimensions: 768,
  model: process.env.REED_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  // Models compared in the evaluation.
  evalModels: (process.env.REED_EVAL_MODELS ?? '@cf/meta/llama-3.1-8b-instruct-fast,@cf/mistralai/mistral-small-3.1-24b-instruct,@cf/qwen/qwen3-30b-a3b-fp8,@cf/meta/llama-3.3-70b-instruct-fp8-fast').split(','),
  maxEventsPerDay: Number(process.env.REED_MAX_EVENTS ?? 8),
  topK: 20,
  // Search setup for the live site: dense, hybrid or diverse (see eval/README.md).
  retrieval: process.env.REED_RETRIEVAL ?? 'dense',
  // Passages handed to the model per event; keeps prompts inside small context windows.
  notePassages: 10,
  judgeModel: process.env.REED_JUDGE_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};

export const CATEGORIES = [
  'tariffs and trade',
  'export controls',
  'sanctions',
  'interest rates and banking',
  'energy and climate',
  'healthcare and drug pricing',
  'technology and data',
  'defense and procurement',
  'tax',
  'labor and immigration',
  'transportation',
  'other',
];
