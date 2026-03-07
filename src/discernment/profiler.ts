// FlowProfiler — builds FlowProfile and SystemProfile from raw signals

import type {
  FlowProfile,
  SystemProfile,
  Objective,
  ObjectiveSummary,
} from './types.js';

/**
 * Builds FlowProfile and SystemProfile from raw signals.
 * Groups flows by primary objective, detects orphans and unserved objectives,
 * and computes engine-wide totals.
 */
export class FlowProfiler {
  /** Build a SystemProfile from flow profiles and objectives */
  buildSystemProfile(
    flowProfiles: FlowProfile[],
    objectives: Objective[],
    lookbackPeriod: number,
  ): SystemProfile {
    // Compute engine-wide totals
    const totalCost = flowProfiles.reduce((sum, fp) => sum + fp.cost.totalCost, 0);
    const totalExecutions = flowProfiles.reduce((sum, fp) => sum + fp.execution.totalExecutions, 0);

    // Detect orphan flows (no primary objective)
    const orphanFlows = flowProfiles
      .filter(fp => !fp.objective)
      .map(fp => fp.flowName);

    // Build objective summaries
    const objectiveSummaries = objectives.map(obj =>
      this.buildObjectiveSummary(obj, flowProfiles),
    );

    // Detect unserved objectives (no flows at all)
    const unservedObjectives = objectiveSummaries
      .filter(s => s.flowCount === 0)
      .map(s => s.objectiveName);

    return {
      timestamp: new Date(),
      lookbackPeriod,
      flowProfiles,
      objectiveSummaries,
      orphanFlows,
      unservedObjectives,
      totalCost,
      totalExecutions,
    };
  }

  /** Build an ObjectiveSummary from an objective and all flow profiles */
  private buildObjectiveSummary(
    objective: Objective,
    flowProfiles: FlowProfile[],
  ): ObjectiveSummary {
    const primaryFlowNames = objective.primaryFlows;
    const secondaryFlowNames = objective.secondaryFlows;
    const allFlowNames = [...new Set([...primaryFlowNames, ...secondaryFlowNames])];

    // Get profiles for flows serving this objective
    const primaryProfiles = flowProfiles.filter(fp => primaryFlowNames.includes(fp.flowName));
    const allProfiles = flowProfiles.filter(fp => allFlowNames.includes(fp.flowName));

    const totalCost = allProfiles.reduce((sum, fp) => sum + fp.cost.totalCost, 0);
    const totalExecutions = allProfiles.reduce((sum, fp) => sum + fp.execution.totalExecutions, 0);

    // Compute average quality across all flows (only those with scores)
    const scoredProfiles = allProfiles.filter(fp => fp.quality.averageScore !== null);
    const averageQuality = scoredProfiles.length > 0
      ? scoredProfiles.reduce((sum, fp) => sum + fp.quality.averageScore!, 0) / scoredProfiles.length
      : null;

    return {
      objectiveName: objective.name,
      description: objective.description,
      flowCount: allFlowNames.length,
      totalCost,
      averageQuality,
      totalExecutions,
      flowNames: allFlowNames,
      primaryFlowNames,
      secondaryFlowNames,
    };
  }
}
