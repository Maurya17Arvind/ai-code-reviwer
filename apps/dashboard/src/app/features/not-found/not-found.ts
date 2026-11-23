import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'acr-not-found',
  imports: [RouterLink],
  template: `
    <h1>Page not found</h1>
    <p>The page you requested does not exist.</p>
    <a routerLink="/">Go to the dashboard</a>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundPage {}
