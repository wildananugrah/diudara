import { NotFoundError } from "../errors";
import type {
  AnalyticsRepositoryPort,
  CommunityMetrics,
} from "../ports/analytics-repository.port";

/**
 * The creator dashboard's overview figures.
 *
 * Thin on purpose, and it takes NO `CommunityRepositoryPort`: the ownership check
 * is not a step this use-case performs before reading, it is a property of the
 * read itself (see `AnalyticsRepositoryPort`). There is nothing to forget here,
 * because there is no way to ask the repository an unscoped question.
 *
 * `null` becomes `NotFoundError` — 404, never 403. A 403 would tell a stranger
 * probing community ids that they had found a real one.
 */
export class GetCommunityMetrics {
  constructor(private readonly analytics: AnalyticsRepositoryPort) {}

  async execute(input: { communityId: string; creatorId: string }): Promise<CommunityMetrics> {
    const metrics = await this.analytics.getMetricsForCreator(input.communityId, input.creatorId);
    if (!metrics) {
      // Deliberately the same message the tier and channel routes use for a
      // community that is not yours: nothing in it distinguishes "not found" from
      // "not yours".
      throw new NotFoundError("community not found");
    }
    return metrics;
  }
}
