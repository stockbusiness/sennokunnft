import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchStaff } from '../../../src/admin-client';
import { ADMIN_COPY } from '../../../src/admin-copy';
import {
  STAFF_COPY,
  formatDate,
  invitationRoleLabel,
  invitationStatusLabel,
  memberRoleLabel,
  memberStatusLabel,
} from '../../../src/staff-copy';
import { InviteForm, RevokeInvitationButton, StaffActionButton } from './forms';

export default async function AdminStaffPage() {
  const result = await fetchStaff();

  if (!result.ok) {
    return (
      <>
        <PageHeader title={STAFF_COPY.title} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={
            result.reason === 'unauthorized'
              ? 'スタッフの管理を行えるのはオーナーだけです。'
              : ADMIN_COPY.unavailableHint
          }
        />
      </>
    );
  }

  const { viewerAccountId, members, invitations } = result.data;
  const activeOwners = members.filter((member) => member.isOwner && member.status === 'active');

  return (
    <>
      <PageHeader title={STAFF_COPY.title} description={STAFF_COPY.description} />

      <Notice tone="alert" title={STAFF_COPY.lastOwnerNote} hint={STAFF_COPY.lastOwnerHint} />

      <h2>{STAFF_COPY.membersHeading}</h2>
      {members.length === 0 ? (
        <EmptyState title={STAFF_COPY.noMembers} hint={STAFF_COPY.noMembersHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table">
            <thead>
              <tr>
                <th scope="col">{STAFF_COPY.columnEmail}</th>
                <th scope="col">{STAFF_COPY.columnRole}</th>
                <th scope="col">{STAFF_COPY.columnStatus}</th>
                <th scope="col">{STAFF_COPY.columnActions}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = member.accountId === viewerAccountId;
                /*
                  ⚠️ 最後のオーナーには操作を出さない。
                     押しても API が断るが、断られる前に手を止めさせる。
                */
                const isLastOwner =
                  member.isOwner && activeOwners.length <= 1 && member.status === 'active';

                return (
                  <tr key={member.accountId}>
                    <td>
                      {member.email ?? STAFF_COPY.emailUnknown}
                      {member.isOwner ? (
                        <>
                          {' '}
                          <StatusBadge label={STAFF_COPY.ownerBadge} tone="success" />
                        </>
                      ) : null}
                    </td>
                    <td>{memberRoleLabel(member.role)}</td>
                    <td>{memberStatusLabel(member.status)}</td>
                    <td>
                      {isSelf ? (
                        <span className="sengoku-form__hint">{STAFF_COPY.selfNote}</span>
                      ) : isLastOwner ? (
                        <span className="sengoku-form__hint">{STAFF_COPY.lastOwnerNote}</span>
                      ) : (
                        <div className="sengoku-actions">
                          {member.status === 'active' ? (
                            <StaffActionButton
                              accountId={member.accountId}
                              change="suspend"
                              label={STAFF_COPY.submitSuspend}
                            />
                          ) : (
                            <StaffActionButton
                              accountId={member.accountId}
                              change="resume"
                              label={STAFF_COPY.submitResume}
                            />
                          )}

                          {member.role === 'operator' ? (
                            <StaffActionButton
                              accountId={member.accountId}
                              change="make_auditor"
                              label="閲覧のみにする"
                            />
                          ) : (
                            <StaffActionButton
                              accountId={member.accountId}
                              change="make_operator"
                              label="運営にする"
                            />
                          )}

                          {/* オーナーにできるのは運営の方だけ（API 側も同じ規則）。 */}
                          {member.role === 'operator' && !member.isOwner ? (
                            <StaffActionButton
                              accountId={member.accountId}
                              change="make_owner"
                              label={STAFF_COPY.submitMakeOwner}
                            />
                          ) : null}

                          <StaffActionButton
                            accountId={member.accountId}
                            change="remove"
                            label={STAFF_COPY.submitRemove}
                            tone="danger"
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>{STAFF_COPY.inviteHeading}</h2>
      <InviteForm />

      <h2>{STAFF_COPY.invitationsHeading}</h2>
      {invitations.length === 0 ? (
        <EmptyState title={STAFF_COPY.noInvitations} hint={STAFF_COPY.noInvitationsHint} />
      ) : (
        <div className="sengoku-table-scroll">
          <table className="sengoku-table">
            <thead>
              <tr>
                <th scope="col">{STAFF_COPY.columnEmail}</th>
                <th scope="col">{STAFF_COPY.columnRole}</th>
                <th scope="col">{STAFF_COPY.columnStatus}</th>
                <th scope="col">{STAFF_COPY.columnExpires}</th>
                <th scope="col">{STAFF_COPY.columnActions}</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{invitation.email}</td>
                  <td>{invitationRoleLabel(invitation.role)}</td>
                  <td>{invitationStatusLabel(invitation)}</td>
                  <td>{formatDate(invitation.expiresAt)}</td>
                  <td>
                    {/* 取り消せるのは、まだ生きている招待だけ。 */}
                    {invitation.isOpen ? (
                      <RevokeInvitationButton invitationId={invitation.id} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
