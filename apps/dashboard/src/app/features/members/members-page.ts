import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { type Member, MemberSchema, type SetupLink } from '@acra/shared-contracts';
import { type OrganizationRole, OrganizationRoleSchema } from '@acra/shared-types';
import * as z from 'zod/mini';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { hasRole, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { AsyncState } from '../../shared/ui/async-state';

/** Team management: invite people, change roles, remove members, issue password setup links. */
@Component({
  selector: 'acr-members-page',
  imports: [AsyncState, DatePipe, ReactiveFormsModule],
  template: `
    <div class="page-header">
      <div>
        <h1>Members</h1>
        <p class="muted">
          Roles:
          @for (r of roles; track r) {
            <span
              ><strong>{{ roleLabels[r] }}</strong
              >: {{ roleDescriptions[r] }}.
            </span>
          }
        </p>
      </div>
    </div>

    @if (feedback(); as f) {
      <p class="banner" [class.banner-ok]="f.ok" [class.banner-error]="!f.ok" role="status">{{ f.text }}</p>
    }
    @if (link(); as l) {
      <div class="banner banner-info" role="status" data-testid="setup-link">
        <div>
          <p>
            <strong>Share this single-use link with {{ l.email }}.</strong> It expires
            {{ l.link.expiresAt | date: 'medium' }} and is shown only now.
          </p>
          <code class="setup-url">{{ l.link.setupUrl }}</code>
        </div>
        <button type="button" class="btn btn-small" (click)="copy(l.link.setupUrl)">Copy link</button>
      </div>
    }

    <acr-async-state
      [loading]="members.isLoading()"
      [error]="loadError()"
      [hasData]="members.hasValue()"
      (retry)="members.reload()"
    >
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">
            Members
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Sign-in</th>
              @if (canManage()) {
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              }
            </tr>
          </thead>
          <tbody>
            @for (m of members.value() ?? []; track m.id) {
              <tr>
                <td>
                  {{ m.displayName }}
                  <div class="muted small">{{ m.email }}</div>
                </td>
                <td>
                  @if (canEdit(m)) {
                    <label class="visually-hidden" [for]="'role-' + m.id">Role of {{ m.displayName }}</label>
                    <select
                      [id]="'role-' + m.id"
                      [value]="m.role"
                      (change)="changeRole(m, $event)"
                      [disabled]="busyId() === m.id"
                    >
                      @for (r of assignableRoles(); track r) {
                        <option [value]="r">{{ roleLabels[r] }}</option>
                      }
                    </select>
                  } @else {
                    {{ roleLabels[m.role] }}
                    @if (m.email === me()?.email) {
                      <span class="muted small">(you)</span>
                    }
                  }
                </td>
                <td>
                  @if (!m.hasPassword) {
                    Invitation pending
                  } @else if (m.lastLoginAt) {
                    {{ m.lastLoginAt | date: 'short' }}
                  } @else {
                    Never
                  }
                </td>
                @if (canManage()) {
                  <td class="row">
                    @if (canEdit(m)) {
                      <button type="button" class="btn btn-small" (click)="newLink(m)" [disabled]="busyId() === m.id">
                        {{ m.hasPassword ? 'Password reset link' : 'New invitation link' }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-small btn-danger"
                        (click)="remove(m)"
                        [disabled]="busyId() === m.id"
                      >
                        Remove
                      </button>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </acr-async-state>

    @if (canManage()) {
      <h2 id="invite-heading">Add a member</h2>
      <form class="form card" [formGroup]="form" (ngSubmit)="invite()" aria-labelledby="invite-heading" novalidate>
        <div class="field">
          <label for="email">E-mail</label>
          <input id="email" type="email" formControlName="email" autocomplete="off" />
        </div>
        <div class="field">
          <label for="displayName">Name</label>
          <input id="displayName" type="text" formControlName="displayName" />
        </div>
        <div class="field">
          <label for="role">Role</label>
          <select id="role" formControlName="role">
            @for (r of assignableRoles(); track r) {
              <option [value]="r">{{ roleLabels[r] }}: {{ roleDescriptions[r] }}</option>
            }
          </select>
        </div>
        @if (showErrors() && form.invalid) {
          <p class="field-error" role="alert">Enter a valid e-mail address and a name.</p>
        }
        <button type="submit" class="btn btn-primary" [disabled]="inviting()">Add member</button>
      </form>
    }
  `,
  styles: `
    .setup-url {
      display: block;
      overflow-wrap: anywhere;
      user-select: all;
    }
    .banner p {
      margin: 0 0 0.25rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MembersPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly orgId = input.required<string>();

  protected readonly roles = OrganizationRoleSchema.options;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly roleDescriptions = ROLE_DESCRIPTIONS;
  protected readonly me = this.session.user;
  protected readonly members = httpResource(() => this.api.orgUrl(this.orgId(), '/members'), {
    parse: (v) => z.array(MemberSchema).parse(v),
  });
  protected readonly loadError = computed(() => (this.members.error() ? errorMessage(this.members.error()) : null));
  private readonly myRole = computed(() => this.session.membership(this.orgId())?.role ?? null);
  protected readonly canManage = computed(() => hasRole(this.myRole(), 'ADMIN'));
  /** Only owners grant the owner role. */
  protected readonly assignableRoles = computed(() =>
    this.roles.filter((r) => r !== 'OWNER' || this.myRole() === 'OWNER'),
  );
  protected readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(320)]],
    displayName: ['', [Validators.required, Validators.maxLength(200)]],
    role: this.fb.control<OrganizationRole>('MEMBER'),
  });
  protected readonly busyId = signal<string | null>(null);
  protected readonly inviting = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly feedback = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly link = signal<{ email: string; link: SetupLink } | null>(null);

  protected canEdit(member: Member): boolean {
    if (!this.canManage() || member.email === this.me()?.email) return false;
    return member.role !== 'OWNER' || this.myRole() === 'OWNER';
  }

  protected async invite(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || this.inviting()) return;
    this.inviting.set(true);
    this.feedback.set(null);
    this.link.set(null);
    try {
      const { member, setupLink } = await this.api.addMember(this.orgId(), this.form.getRawValue());
      this.members.update((list) => [...(list ?? []), member]);
      this.form.reset({ email: '', displayName: '', role: 'MEMBER' });
      this.showErrors.set(false);
      if (setupLink) this.link.set({ email: member.email, link: setupLink });
      else this.feedback.set({ ok: true, text: `${member.email} already has an account and can sign in now.` });
    } catch (error) {
      this.feedback.set({ ok: false, text: errorMessage(error) });
    } finally {
      this.inviting.set(false);
    }
  }

  protected async changeRole(member: Member, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const role = select.value as OrganizationRole;
    await this.run(
      member,
      async () => {
        const updated = await this.api.updateMemberRole(this.orgId(), member.id, role);
        this.members.update((list) => list?.map((m) => (m.id === updated.id ? updated : m)));
        return `${member.displayName} is now ${ROLE_LABELS[role]}.`;
      },
      () => (select.value = member.role),
    );
  }

  protected async remove(member: Member): Promise<void> {
    if (!confirm(`Remove ${member.displayName} from this organization?`)) return;
    await this.run(member, async () => {
      await this.api.removeMember(this.orgId(), member.id);
      this.members.update((list) => list?.filter((m) => m.id !== member.id));
      return `${member.displayName} was removed.`;
    });
  }

  protected async newLink(member: Member): Promise<void> {
    await this.run(member, async () => {
      this.link.set({ email: member.email, link: await this.api.issueSetupLink(this.orgId(), member.id) });
      return null;
    });
  }

  protected copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  private async run(member: Member, action: () => Promise<string | null>, onError?: () => void): Promise<void> {
    this.busyId.set(member.id);
    this.feedback.set(null);
    try {
      const text = await action();
      if (text) this.feedback.set({ ok: true, text });
    } catch (error) {
      onError?.();
      this.feedback.set({ ok: false, text: errorMessage(error) });
    } finally {
      this.busyId.set(null);
    }
  }
}
