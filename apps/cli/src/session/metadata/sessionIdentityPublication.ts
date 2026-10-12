/** Allocation alone is not durable resume identity. Preserve requested resumes,
 * but require agent-native evidence before publishing a newly allocated session. */
export function canPublishSessionResumeIdentity(input: Readonly<{
    isExistingResume: boolean;
    hasResumeEvidence: boolean;
}>): boolean {
    return input.isExistingResume || input.hasResumeEvidence;
}
