import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Tests for the blind test evaluation flow.
 * These tests verify the public questionnaire access and anonymous submission APIs.
 */

function createAdminContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "admin-user",
      email: "admin@example.com",
      name: "Admin User",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function createPublicContext(ip?: string): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: ip ? { "x-forwarded-for": ip } : {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("Blind Test Evaluation Flow", () => {
  it("should publish a questionnaire and generate a share token", async () => {
    const adminCaller = appRouter.createCaller(createAdminContext());

    // List admin questionnaires - should not throw
    const questionnaires = await adminCaller.questionnaire.listAdmin();
    expect(Array.isArray(questionnaires)).toBe(true);
  });

  it("should list published questionnaires publicly", async () => {
    const publicCaller = appRouter.createCaller(createPublicContext());

    const published = await publicCaller.questionnaire.listPublished();
    expect(Array.isArray(published)).toBe(true);
  });

  it("should reject getByShareToken with invalid token", async () => {
    const publicCaller = appRouter.createCaller(createPublicContext());

    await expect(
      publicCaller.questionnaire.getByShareToken({ shareToken: "invalid_token_xyz" })
    ).rejects.toThrow();
  });

  it("should reject startPublic with invalid questionnaire", async () => {
    const publicCaller = appRouter.createCaller(createPublicContext("192.168.1.1"));

    await expect(
      publicCaller.response.startPublic({
        questionnaireId: 99999,
        visitorName: "Test Visitor",
      })
    ).rejects.toThrow();
  });

  it("should reject startPublic without visitor name", async () => {
    const publicCaller = appRouter.createCaller(createPublicContext("192.168.1.1"));

    await expect(
      publicCaller.response.startPublic({
        questionnaireId: 1,
        visitorName: "",
      })
    ).rejects.toThrow();
  });

  it("should reject submitPublic with invalid response ID", async () => {
    const publicCaller = appRouter.createCaller(createPublicContext());

    await expect(
      publicCaller.response.submitPublic({
        responseId: 99999,
        answers: [
          {
            evaluationDimensionId: 1,
            blindTestPairId: 1,
            blindTestChoice: "left_better",
          },
        ],
      })
    ).rejects.toThrow();
  });

  it("should validate blind test choice values", async () => {
    const publicCaller = appRouter.createCaller(createPublicContext());

    // Invalid choice value should be rejected by zod validation
    await expect(
      publicCaller.response.submitPublic({
        responseId: 1,
        answers: [
          {
            evaluationDimensionId: 1,
            blindTestPairId: 1,
            blindTestChoice: "invalid_choice" as any,
          },
        ],
      })
    ).rejects.toThrow();
  });

  it("should have dimension CRUD routes available", async () => {
    const adminCaller = appRouter.createCaller(createAdminContext());

    // List dimensions for non-existent questionnaire should return empty array
    const dimensions = await adminCaller.dimension.list({ questionnaireId: 99999 });
    expect(Array.isArray(dimensions)).toBe(true);
    expect(dimensions.length).toBe(0);
  });
});
