export const stripAnsi = (str: string): string => {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
  ].join('|');

  return str.replace(new RegExp(pattern, 'g'), '');
};

export const getModelPrice = (model: string, prices: any[]) => {
  if (!prices || !model) return null;
  const exact = prices.find((p: any) => p.id === model);
  if (exact) return exact;
  
  const lower = model.toLowerCase();
  
  // Custom fallback mapping for common variations
  if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3.5-sonnet')) return prices.find(p => p.id === 'claude-3.5-sonnet');
  if (lower.includes('claude-sonnet-4') || lower.includes('claude-4.5') || lower.includes('claude-4-5')) return prices.find(p => p.id === 'claude-sonnet-4.5');
  if (lower.includes('claude-3-opus')) return prices.find(p => p.id === 'claude-3-opus');
  if (lower.includes('gemini-3.1-pro') || lower.includes('gemini-3-1-pro')) return prices.find(p => p.id === 'gemini-3-1-pro-preview');
  if (lower.includes('gemini-3-pro')) return prices.find(p => p.id === 'gemini-3-pro-preview');
  if (lower.includes('gemini-2.5-pro')) return prices.find(p => p.id === 'gemini-2.5-pro');
  if (lower.includes('o1-mini')) return prices.find(p => p.id === 'o1-mini');
  if (lower.includes('o1-preview')) return prices.find(p => p.id === 'o1-preview');
  if (lower.includes('o3-mini')) return prices.find(p => p.id === 'o3-mini');
  if (lower.includes('gpt-4o-mini')) return prices.find(p => p.id === 'gpt-4o-mini');
  if (lower.includes('gpt-4o')) return prices.find(p => p.id === 'gpt-4o');

  // Generic fuzzy match
  const fuzzy = prices.find((p: any) => lower.includes(p.id) || p.id.includes(lower));
  if (fuzzy) return fuzzy;
  
  return null;
};

export const calculateCost = (tokenUsage: any[], pricesData: any): number => {
  if (!tokenUsage || !pricesData?.prices) return 0;
  return tokenUsage.reduce((acc, usage) => {
    const price = getModelPrice(usage.model, pricesData.prices);
    if (!price) return acc;
    const inputCost = (usage.input / 1000000) * (price.input || 0);
    const outputCost = (usage.output / 1000000) * (price.output || 0);
    return acc + inputCost + outputCost;
  }, 0);
};

export const formatCost = (cost: number): string => {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '$' + cost.toFixed(4);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cost);
};

export const calculateCycleTimeMs = (item: any): number => {
  // If the item hasn't started yet, cycle time is 0
  if (!item.history || item.history.length === 0) {
    if (item.status === 'TODO' || item.status === 'BLOCKED') return 0;
    return item.status === 'DONE' || item.status === 'ARCHIVED' 
      ? new Date(item.updatedAt).getTime() - new Date(item.createdAt).getTime()
      : Date.now() - new Date(item.createdAt).getTime();
  }

  // Find the first time it entered an active state (not TODO, not BLOCKED)
  let startedAt: Date | null = null;
  for (const record of item.history) {
    if (record.toStatus !== 'TODO' && record.toStatus !== 'BLOCKED') {
      startedAt = new Date(record.timestamp);
      break;
    }
  }

  if (!startedAt) return 0;

  // Find the first time it entered a DONE or ARCHIVED state after starting
  let completedAt: Date | null = null;
  if (item.status === 'DONE' || item.status === 'ARCHIVED') {
    for (const record of item.history) {
      if (record.toStatus === 'DONE' || record.toStatus === 'ARCHIVED') {
        completedAt = new Date(record.timestamp);
        break;
      }
    }
    if (!completedAt) completedAt = new Date(item.updatedAt);
  }

  return (completedAt ? completedAt.getTime() : Date.now()) - startedAt.getTime();
};
