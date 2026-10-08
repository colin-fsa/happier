import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import { t } from '@/text';

import { computePoolMembershipDiff } from './commitPoolMembershipBatch';
import { MultiSelectField } from '@/components/ui/forms/dropdown/MultiSelectField';

/** A profile eligible for pool membership. */
export type PoolMembershipCandidate = Readonly<{
    profileId: string;
    title: string;
    subtitle?: string;
}>;

export type PoolMembersSelectFieldProps = Readonly<{
    candidates: ReadonlyArray<PoolMembershipCandidate>;
    /** Current authoritative membership (profile ids). */
    selectedProfileIds: ReadonlyArray<string>;
    /** Receives the target membership in candidate order when the draft is committed. */
    onCommit: (nextSelectedProfileIds: ReadonlyArray<string>) => void;
    disabled?: boolean;
    testID?: string;
}>;

/**
 * The single membership control for a pool: a multi-select dropdown listing
 * every eligible profile — members and non-members alike — with a checkbox each.
 *
 * Toggling edits a LOCAL DRAFT and issues no request. The draft is committed as
 * one batch when the menu closes, because the wire has no batch endpoint: each
 * add/remove is a separate generation-chained call, so committing per keystroke
 * would fire a burst of sequential round-trips and churn the rows underneath the
 * open menu. Removals are confirmed once, at commit, since unchecking is
 * otherwise a silent destructive action.
 */
export const PoolMembersSelectField = React.memo(function PoolMembersSelectField(
    props: PoolMembersSelectFieldProps,
) {
    const { theme } = useUnistyles();
    const { candidates, onCommit, selectedProfileIds } = props;
    const commitDraft = React.useCallback(async (nextSelectedProfileIds: ReadonlyArray<string>) => {
        const { toAdd, toRemove } = computePoolMembershipDiff(selectedProfileIds, nextSelectedProfileIds);
        if (toAdd.length === 0 && toRemove.length === 0) return;

        if (toRemove.length > 0) {
            const removedTitles = toRemove.map((profileId) => (
                candidates.find((candidate) => candidate.profileId === profileId)?.title ?? profileId
            ));
            const ok = await Modal.confirm(
                t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
                t('connectedServices.detail.groupActions.removeMembersConfirmBody', {
                    count: toRemove.length,
                    members: removedTitles.join(', '),
                }),
                {
                    confirmText: t('connectedServices.detail.groupActions.removeMember'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            );
            if (!ok) return;
        }

        onCommit(nextSelectedProfileIds);
    }, [candidates, onCommit, selectedProfileIds]);

    return (
        <MultiSelectField
            candidates={candidates.map((candidate) => ({ id: candidate.profileId, title: candidate.title, subtitle: candidate.subtitle }))}
            selectedIds={selectedProfileIds}
            onCommit={commitDraft}
            title={t('connectedServices.detail.groupActions.manageMembersTitle')}
            subtitle={(count, total) => t('connectedServices.detail.groupActions.manageMembersSubtitle', { count, total })}
            emptySubtitle={t('connectedServices.detail.profiles.empty')}
            searchPlaceholder={t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
            optionTestIDPrefix="connected-services-pool-detail:members:option"
            icon={<Icon name="users" size={20} color={theme.colors.accent.blue} />}
            disabled={props.disabled}
            testID={props.testID}
        />
    );
});
