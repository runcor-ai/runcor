// ModelAnalyzer — sends system profile to model for strategic recommendations

import type { ModelRequest, ModelResponse } from '../model/provider.js';
import type { ModelInterface } from '../types.js';
import { buildDefaultPrompt, buildRecommendationSchema } from './prompts.js';
import type {
  SystemProfile,
  Signal,
  Recommendation,
  ModelAnalysisResult,
  DiscernmentConfig,
} from './types.js';

/** Minimal interface for cost-tracked model calls */
interface CostTrackerLike {
  wrapComplete(request: ModelRequest, context: { executionId: string; flowName: string; userId: string | null }): Promise<ModelResponse>;
}

/** Dependencies for ModelAnalyzer */
export interface ModelAnalyzerDeps {
  router: ModelInterface;
  costTracker: CostTrackerLike | null;
  config: DiscernmentConfig;
}

let idCounter = 0;

function generateId(): string {
  return `rec-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Performs model-based analysis by sending the system profile and signals
 * to a model for strategic recommendations.
 */
export class ModelAnalyzer {
  private readonly deps: ModelAnalyzerDeps;

  constructor(deps: ModelAnalyzerDeps) {
    this.deps = deps;
  }

  /** Analyze the system profile and produce recommendations */
  async analyze(
    systemProfile: SystemProfile,
    signals: Signal[],
  ): Promise<{
    recommendations: Recommendation[];
    modelAnalysis: ModelAnalysisResult;
    signals?: Signal[];
  }> {
    const request = this.buildRequest(systemProfile, signals);

    try {
      const response = await this.callModel(request);
      return this.parseResponse(response);
    } catch (err: unknown) {
      return this.handleError(err);
    }
  }

  private buildRequest(systemProfile: SystemProfile, signals: Signal[]): ModelRequest {
    const prompt = this.deps.config.prompt
      ? this.deps.config.prompt + '\n\n' + buildDefaultPrompt(systemProfile, signals)
      : buildDefaultPrompt(systemProfile, signals);

    const request: ModelRequest = {
      prompt,
      responseFormat: buildRecommendationSchema(),
      maxTokens: 4096,
    };

    if (this.deps.config.provider) {
      request.provider = this.deps.config.provider;
    }

    return request;
  }

  private async callModel(request: ModelRequest): Promise<ModelResponse> {
    if (this.deps.costTracker) {
      return this.deps.costTracker.wrapComplete(request, {
        executionId: `discernment-${Date.now()}`,
        flowName: '__discernment',
        userId: null,
      });
    }
    return this.deps.router.complete(request);
  }

  private parseResponse(response: ModelResponse): {
    recommendations: Recommendation[];
    modelAnalysis: ModelAnalysisResult;
  } {
    const modelAnalysis: ModelAnalysisResult = {
      provider: response.provider,
      model: response.model,
      cost: 0, // actual cost tracked via CostTracker
      success: true,
      error: null,
    };

    // Try to extract recommendations from parsed response
    let rawRecs: unknown[] | undefined;

    if (response.parsed && typeof response.parsed === 'object') {
      const parsed = response.parsed as Record<string, unknown>;
      if (Array.isArray(parsed.recommendations)) {
        rawRecs = parsed.recommendations;
      }
    }

    if (!rawRecs) {
      // Try parsing from text
      try {
        const textParsed = JSON.parse(response.text);
        if (textParsed && Array.isArray(textParsed.recommendations)) {
          rawRecs = textParsed.recommendations;
        }
      } catch {
        // Parse failure
      }
    }

    if (!rawRecs) {
      return {
        recommendations: [],
        modelAnalysis: {
          ...modelAnalysis,
          success: false,
          error: 'Failed to parse recommendations from model response',
        },
      };
    }

    const now = new Date();
    const recommendations: Recommendation[] = rawRecs.map((item) => {
      const raw = item as Record<string, unknown>;
      return {
        id: generateId(),
        target: (raw.target as string) ?? 'system',
        targetType: (raw.targetType as Recommendation['targetType']) ?? 'system',
        action: (raw.action as Recommendation['action']) ?? 'investigate',
        confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
        explanation: (raw.explanation as string) ?? '',
        evidenceRefs: Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs as string[] : [],
        status: 'pending' as const,
        createdAt: now,
      };
    });

    return { recommendations, modelAnalysis };
  }

  private handleError(err: unknown): {
    recommendations: Recommendation[];
    modelAnalysis: ModelAnalysisResult;
    signals: Signal[];
  } {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const modelAnalysis: ModelAnalysisResult = {
      provider: 'unknown',
      model: 'unknown',
      cost: 0,
      success: false,
      error: errorMessage,
    };

    const failureSignal: Signal = {
      id: `sig-fail-${Date.now()}`,
      checkName: 'model-analysis-failed',
      target: 'system',
      targetType: 'system',
      severity: 'warning',
      evidence: { error: errorMessage },
      timestamp: new Date(),
    };

    return {
      recommendations: [],
      modelAnalysis,
      signals: [failureSignal],
    };
  }
}
