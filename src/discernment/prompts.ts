// Discernment prompt builder — constructs analysis prompts for model-based analysis

import type { SystemProfile, Signal } from './types.js';

/**
 * Builds the default discernment analysis prompt from system profile and heuristic signals.
 * The prompt instructs the model to act as an operations advisor and produce structured recommendations.
 */
export function buildDefaultPrompt(systemProfile: SystemProfile, signals: Signal[]): string {
  const sections: string[] = [];

  // Role instruction
  sections.push(
    'You are an experienced AI operations advisor reviewing a portfolio of AI workflows.',
    'Analyze the system profile below and recommend actions for each flow and objective.',
    '',
  );

  // Engine summary
  sections.push(
    '## System Summary',
    `- Total flows: ${systemProfile.flowProfiles.length}`,
    `- Total cost (lookback period): ${systemProfile.totalCost}`,
    `- Total executions: ${systemProfile.totalExecutions}`,
    `- Lookback period: ${systemProfile.lookbackPeriod} seconds`,
    `- Orphan flows (no objective): ${systemProfile.orphanFlows.length > 0 ? systemProfile.orphanFlows.join(', ') : 'none'}`,
    `- Unserved objectives (no flows): ${systemProfile.unservedObjectives.length > 0 ? systemProfile.unservedObjectives.join(', ') : 'none'}`,
    '',
  );

  // Objective summaries
  if (systemProfile.objectiveSummaries.length > 0) {
    sections.push('## Objectives');
    for (const obj of systemProfile.objectiveSummaries) {
      sections.push(
        `### ${obj.objectiveName}: ${obj.description}`,
        `- Flows: ${obj.flowNames.join(', ')} (${obj.flowCount} total)`,
        `- Primary flows: ${obj.primaryFlowNames.join(', ')}`,
        `- Secondary flows: ${obj.secondaryFlowNames.length > 0 ? obj.secondaryFlowNames.join(', ') : 'none'}`,
        `- Total cost: ${obj.totalCost}`,
        `- Average quality: ${obj.averageQuality !== null ? obj.averageQuality.toFixed(2) : 'no data'}`,
        `- Total executions: ${obj.totalExecutions}`,
        '',
      );
    }
  }

  // Flow profiles detail
  if (systemProfile.flowProfiles.length > 0) {
    sections.push('## Flow Details');
    for (const fp of systemProfile.flowProfiles) {
      sections.push(`### ${fp.flowName}`);
      sections.push(`- Objective: ${fp.objective ?? 'orphan (untagged)'}`);
      sections.push(`- Cost: ${fp.cost.totalCost} (${(fp.cost.costPercentOfTotal * 100).toFixed(1)}% of total, trend: ${fp.cost.costTrend})`);
      sections.push(`- Executions: ${fp.execution.totalExecutions} (success rate: ${(fp.execution.successRate * 100).toFixed(0)}%)`);
      if (fp.quality.averageScore !== null) {
        sections.push(`- Quality: ${fp.quality.averageScore.toFixed(2)} (trend: ${fp.quality.scoreTrend ?? 'no data'})`);
      }
      if (fp.agent) {
        sections.push(`- Agent: avg ${fp.agent.averageIterations} iterations, hard stop rate: ${(fp.agent.hardStopRate * 100).toFixed(0)}%`);
      }
      if (fp.schedule) {
        sections.push(`- Schedule: ${fp.schedule.cronExpression}`);
      }
      if (fp.mcpServer) {
        sections.push(`- MCP server: ${fp.mcpServer.externalInvocationCount} external invocations`);
      }
      sections.push('');
    }
  }

  // Heuristic signals
  if (signals.length > 0) {
    sections.push('## Pre-Identified Issues');
    for (const signal of signals) {
      sections.push(
        `- [${signal.severity.toUpperCase()}] ${signal.checkName} on ${signal.target}: ${JSON.stringify(signal.evidence)}`,
      );
    }
    sections.push('');
  }

  // Instructions
  sections.push(
    '## Instructions',
    'For each flow and objective, recommend one of these actions:',
    '- **keep**: Flow is performing well and aligned with its objective',
    '- **optimize**: Flow has potential for improvement (cost reduction, quality improvement)',
    '- **merge**: Two or more flows overlap significantly and should be consolidated',
    '- **retire**: Flow is idle, redundant, or not delivering value',
    '- **investigate**: Something unusual requires human attention',
    '- **escalate**: Urgent issue requiring immediate action',
    '',
    'For each recommendation provide:',
    '- target: the flow name, objective name, or "system"',
    '- targetType: "flow", "objective", or "system"',
    '- action: one of the actions above',
    '- confidence: 0.0–1.0 (low: 0–0.3, medium: 0.3–0.7, high: 0.7–1.0)',
    '- explanation: plain-language reasoning citing specific evidence',
    '- evidenceRefs: signal IDs that support this recommendation',
    '',
    'Respond with a JSON object containing a "recommendations" array.',
  );

  return sections.join('\n');
}

/**
 * Builds the JSON schema for structured recommendation output.
 * Used as responseFormat in the model request.
 */
export function buildRecommendationSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            targetType: { type: 'string', enum: ['flow', 'objective', 'system'] },
            action: { type: 'string', enum: ['keep', 'optimize', 'merge', 'retire', 'investigate', 'escalate'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            explanation: { type: 'string' },
            evidenceRefs: { type: 'array', items: { type: 'string' } },
          },
          required: ['target', 'targetType', 'action', 'confidence', 'explanation', 'evidenceRefs'],
        },
      },
    },
    required: ['recommendations'],
  };
}
