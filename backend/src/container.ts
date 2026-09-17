/**
 * Composition root. The ONLY module that names a concrete implementation —
 * every service above receives its collaborators through the constructor, so
 * swapping Drizzle for something else, or the mock gateway for Midtrans, is an
 * edit to this file alone (DIP).
 */
import { env, rtmpBaseUrl } from "./config/env.ts";
import { db } from "./infrastructure/db/client.ts";

import { BunPasswordHasher } from "./infrastructure/security/BunPasswordHasher.ts";
import { JwtTokenIssuer } from "./infrastructure/security/JwtTokenIssuer.ts";
import { LocalFileStorage } from "./infrastructure/storage/LocalFileStorage.ts";
import { MockPaymentGateway } from "./infrastructure/payment/MockPaymentGateway.ts";
import { OpenRouterCommunityBuilder } from "./infrastructure/ai/OpenRouterCommunityBuilder.ts";

import { DrizzleUserRepository } from "./infrastructure/repositories/DrizzleUserRepository.ts";
import { DrizzleCommunityRepository } from "./infrastructure/repositories/DrizzleCommunityRepository.ts";
import { DrizzleMembershipRepository } from "./infrastructure/repositories/DrizzleMembershipRepository.ts";
import { DrizzlePostRepository } from "./infrastructure/repositories/DrizzlePostRepository.ts";
import {
  DrizzleCommentRepository, DrizzleDocumentRepository, DrizzleQuizRepository,
  DrizzleSyllabusRepository,
  DrizzleTierRepository, DrizzleUploadRepository,
} from "./infrastructure/repositories/DrizzleContentRepositories.ts";
import {
  DrizzlePaymentRepository, DrizzleSubscriptionRepository,
} from "./infrastructure/repositories/DrizzleCommerceRepositories.ts";
import {
  DrizzleConversationRepository, DrizzleMessageRepository,
} from "./infrastructure/repositories/DrizzleChatRepositories.ts";
import { DrizzleStatsRepository } from "./infrastructure/repositories/DrizzleStatsRepository.ts";
import { DrizzleLiveRepository } from "./infrastructure/repositories/DrizzleLiveRepository.ts";
import { DrizzleNotificationRepository } from "./infrastructure/repositories/DrizzleNotificationRepository.ts";
import { InProcessEventBus } from "./infrastructure/events/InProcessEventBus.ts";

import { AccessPolicy } from "./application/AccessPolicy.ts";
import { AuthService } from "./application/AuthService.ts";
import { CommunityBuilderService } from "./application/CommunityBuilderService.ts";
import { ChatService } from "./application/ChatService.ts";
import { CheckoutService } from "./application/CheckoutService.ts";
import { CommunityService } from "./application/CommunityService.ts";
import { LiveService } from "./application/LiveService.ts";
import { NotificationService } from "./application/NotificationService.ts";
import { MembershipService } from "./application/MembershipService.ts";
import { PostService } from "./application/PostService.ts";
import { UploadService } from "./application/UploadService.ts";
import type { TokenIssuer } from "./domain/ports.ts";

export function createContainer() {
  const hasher = new BunPasswordHasher();
  const tokens: TokenIssuer = new JwtTokenIssuer(env.JWT_SECRET, env.JWT_EXPIRES_IN);
  const storage = new LocalFileStorage(env.STORAGE_DIR);
  const gateway = new MockPaymentGateway();
  const builderAi = new OpenRouterCommunityBuilder(
    env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.PUBLIC_URL,
  );

  const userRepo = new DrizzleUserRepository(db);
  const communityRepo = new DrizzleCommunityRepository(db);
  const membershipRepo = new DrizzleMembershipRepository(db);
  const postRepo = new DrizzlePostRepository(db);
  const commentRepo = new DrizzleCommentRepository(db);
  const syllabusRepo = new DrizzleSyllabusRepository(db);
  const quizRepo = new DrizzleQuizRepository(db);
  const documentRepo = new DrizzleDocumentRepository(db);
  const tierRepo = new DrizzleTierRepository(db);
  const uploadRepo = new DrizzleUploadRepository(db);
  const subscriptionRepo = new DrizzleSubscriptionRepository(db);
  const paymentRepo = new DrizzlePaymentRepository(db);
  const conversationRepo = new DrizzleConversationRepository(db);
  const messageRepo = new DrizzleMessageRepository(db);
  const statsRepo = new DrizzleStatsRepository(db, documentRepo);
  const liveRepo = new DrizzleLiveRepository(db);
  const notificationRepo = new DrizzleNotificationRepository(db);

  const access = new AccessPolicy(membershipRepo);

  /**
   * The bus, and its one subscriber.
   *
   * THIS SUBSCRIPTION IS LOAD-BEARING AND SILENT IF LOST. Services emit whether
   * or not anyone listens, so deleting the `subscribe` line below compiles,
   * runs, raises nothing, and simply stops every notification in the product.
   * container.test.ts asserts it is still here.
   */
  const events = new InProcessEventBus();
  const notifications = new NotificationService(
    notificationRepo, userRepo, communityRepo, tierRepo, membershipRepo, postRepo,
  );
  events.subscribe((event) => notifications.handle(event));

  return {
    tokens,
    auth: new AuthService(userRepo, hasher, tokens),
    communities: new CommunityService(
      communityRepo, membershipRepo, postRepo, syllabusRepo, quizRepo, documentRepo, uploadRepo, statsRepo, access,
    ),
    communityBuilder: new CommunityBuilderService(builderAi, communityRepo, membershipRepo, tierRepo),
    posts: new PostService(postRepo, commentRepo, uploadRepo, access, events),
    members: new MembershipService(membershipRepo, subscriptionRepo, userRepo, access, events),
    checkout: new CheckoutService(tierRepo, subscriptionRepo, paymentRepo, membershipRepo, gateway, events),
    chat: new ChatService(conversationRepo, messageRepo, userRepo, uploadRepo, events),
    notifications,
    events,
    uploads: new UploadService(uploadRepo, storage, documentRepo, access),
    live: new LiveService(liveRepo, access, rtmpBaseUrl()),
  };
}

export type Container = ReturnType<typeof createContainer>;
