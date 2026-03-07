// ObjectiveRegistry — manages objectives and flow-objective mappings

import { EngineError } from '../errors.js';
import type { Objective, ObjectiveDeclaration, FlowTag } from './types.js';

const MAX_NAME_LENGTH = 128;

/**
 * Manages business objective declarations and flow-to-objective mappings.
 * Provides orphan flow and unserved objective detection.
 */
export class ObjectiveRegistry {
  private readonly objectives = new Map<string, ObjectiveDeclaration>();
  private readonly flowTags = new Map<string, FlowTag>();

  /** Register a business objective */
  addObjective(objective: ObjectiveDeclaration): void {
    if (!objective.name || objective.name.trim().length === 0) {
      throw new EngineError(
        'Objective name must be non-empty.',
        'INVALID_OBJECTIVE',
      );
    }
    if (objective.name.length > MAX_NAME_LENGTH) {
      throw new EngineError(
        `Objective name must be at most ${MAX_NAME_LENGTH} characters.`,
        'INVALID_OBJECTIVE',
      );
    }
    if (this.objectives.has(objective.name)) {
      throw new EngineError(
        `Objective "${objective.name}" already exists.`,
        'DUPLICATE_OBJECTIVE',
      );
    }
    this.objectives.set(objective.name, { ...objective });
  }

  /** Remove an objective. Clears flow references — primary loss makes orphan, secondary removal cleans list entry. */
  removeObjective(name: string): void {
    if (!this.objectives.has(name)) {
      throw new EngineError(
        `Objective "${name}" not found.`,
        'OBJECTIVE_NOT_FOUND',
      );
    }
    this.objectives.delete(name);

    // Clear references from all flow tags
    for (const tag of this.flowTags.values()) {
      if (tag.primaryObjective === name) {
        tag.primaryObjective = '';
      }
      tag.secondaryObjectives = tag.secondaryObjectives.filter(o => o !== name);
    }
  }

  /** Return all declared objectives with their associated flow lists */
  listObjectives(): Objective[] {
    const result: Objective[] = [];
    for (const decl of this.objectives.values()) {
      result.push(this.buildObjective(decl));
    }
    return result;
  }

  /** Return a single objective by name, or null if not found */
  getObjective(name: string): Objective | null {
    const decl = this.objectives.get(name);
    if (!decl) return null;
    return this.buildObjective(decl);
  }

  /** Check if an objective exists */
  hasObjective(name: string): boolean {
    return this.objectives.has(name);
  }

  /** Store a flow-objective mapping */
  addFlowTag(tag: FlowTag): void {
    this.flowTags.set(tag.flowName, { ...tag });
  }

  /** Remove a flow-objective mapping */
  removeFlowTag(flowName: string): void {
    this.flowTags.delete(flowName);
  }

  /** Get a flow's tag, or null if not tracked */
  getFlowTag(flowName: string): FlowTag | null {
    return this.flowTags.get(flowName) ?? null;
  }

  /** Return flow names that have no (or empty) primary objective */
  listOrphanFlows(): string[] {
    const orphans: string[] = [];
    for (const tag of this.flowTags.values()) {
      if (!tag.primaryObjective) {
        orphans.push(tag.flowName);
      }
    }
    return orphans;
  }

  /** Return objective names that have no flows (primary or secondary) */
  listUnservedObjectives(): string[] {
    const served = new Set<string>();
    for (const tag of this.flowTags.values()) {
      if (tag.primaryObjective) {
        served.add(tag.primaryObjective);
      }
      for (const sec of tag.secondaryObjectives) {
        served.add(sec);
      }
    }

    const unserved: string[] = [];
    for (const name of this.objectives.keys()) {
      if (!served.has(name)) {
        unserved.push(name);
      }
    }
    return unserved;
  }

  /** Build an Objective view from a declaration, populating flow lists */
  private buildObjective(decl: ObjectiveDeclaration): Objective {
    const primaryFlows: string[] = [];
    const secondaryFlows: string[] = [];
    for (const tag of this.flowTags.values()) {
      if (tag.primaryObjective === decl.name) {
        primaryFlows.push(tag.flowName);
      }
      if (tag.secondaryObjectives.includes(decl.name)) {
        secondaryFlows.push(tag.flowName);
      }
    }
    return {
      name: decl.name,
      description: decl.description,
      primaryFlows,
      secondaryFlows,
    };
  }
}
