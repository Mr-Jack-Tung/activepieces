import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { FolderActions } from '@activepieces/ui/feature-folders-store';
import {
  AuthenticationService,
  EmbeddingService,
  NavigationService,
  UiCommonModule,
} from '@activepieces/ui/common';
import { Observable, combineLatest, forkJoin, map, of, take } from 'rxjs';
import { ApFlagId, ProjectMemberRole, supportUrl } from '@activepieces/shared';
import {
  DashboardService,
  FlagService,
  isVersionMatch,
} from '@activepieces/ui/common';
import { SidenavRouteItemComponent } from '../sidenav-route-item/sidenav-route-item.component';
import { CommonModule } from '@angular/common';

type SideNavRoute = {
  icon: string;
  caption: string;
  route: string | undefined;
  effect?: () => void;
  showInSideNav$: Observable<boolean>;
  showLock$?: Observable<boolean>;
  showNotification$?: Observable<boolean>;
};

@Component({
  selector: 'app-sidenav-routes-list',
  templateUrl: './sidenav-routes-list.component.html',
  styleUrls: ['./sidenav-routes-list.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [SidenavRouteItemComponent, CommonModule, UiCommonModule],
})
export class SidenavRoutesListComponent implements OnInit {
  logoUrl$: Observable<string>;
  sideNavRoutes$: Observable<SideNavRoute[]>;
  mainDashboardRoutes: SideNavRoute[] = [];
  demoPlatform$: Observable<boolean> = this.flagService.isFlagEnabled(
    ApFlagId.SHOW_PLATFORM_DEMO
  );
  currentVersion$?: Observable<string>;
  latestVersion$?: Observable<string>;
  isVersionMatch$?: Observable<boolean>;

  readonly supportRoute: SideNavRoute = {
    caption: 'Support',
    icon: 'assets/img/custom/support.svg',
    route: undefined,
    showInSideNav$: this.flagServices.isFlagEnabled(ApFlagId.SHOW_COMMUNITY),
    showLock$: of(false),
    effect: () => {
      this.openSupport();
    },
  };
  readonly docsRoute: SideNavRoute = {
    caption: 'Docs',
    icon: 'assets/img/custom/dashboard/documentation.svg',
    route: undefined,
    showInSideNav$: this.flagServices.isFlagEnabled(ApFlagId.SHOW_DOCS),
    showLock$: of(false),
    effect: () => {
      this.openDocs();
    },
  };
  platformDashboardRoutes: SideNavRoute[] = [
    {
      icon: 'assets/img/custom/dashboard/projects.svg',
      caption: $localize`Projects`,
      route: 'platform/projects',
      showInSideNav$: of(true),
      showLock$: this.demoPlatform$,
    },
    {
      icon: 'assets/img/custom/dashboard/appearance.svg',
      caption: $localize`Appearance`,
      route: 'platform/appearance',
      showInSideNav$: of(true),
      showLock$: this.demoPlatform$,
    },
    {
      icon: 'assets/img/custom/dashboard/pieces.svg',
      caption: $localize`Pieces`,
      route: 'platform/pieces',
      showInSideNav$: of(true),
      showLock$: this.demoPlatform$,
    },
    {
      icon: 'assets/img/custom/dashboard/templates.svg',
      caption: $localize`Templates`,
      route: 'platform/templates',
      showInSideNav$: of(true),
      showLock$: this.demoPlatform$,
    },
    {
      icon: 'assets/img/custom/dashboard/users.svg',
      caption: $localize`Users`,
      route: 'platform/users',
      showInSideNav$: of(true),
      showLock$: of(false),
    },
    {
      icon: 'assets/img/custom/dashboard/settings.svg',
      caption: $localize`Settings`,
      route: 'platform/settings',
      showInSideNav$: of(true),
      showLock$: of(false),
      showNotification$: this.isVersionMatch$,
    },
  ];
  constructor(
    public router: Router,
    private store: Store,
    private flagServices: FlagService,
    private dashboardService: DashboardService,
    private navigationService: NavigationService,
    private embeddingService: EmbeddingService,
    private authenticationService: AuthenticationService,
    private flagService: FlagService
  ) {
    this.logoUrl$ = this.flagServices
      .getLogos()
      .pipe(map((logos) => logos.logoIconUrl));
    this.mainDashboardRoutes = [
      {
        icon: 'assets/img/custom/dashboard/flows.svg',
        caption: $localize`Flows`,
        route: 'flows',
        effect: () => {
          this.store.dispatch(FolderActions.showAllFlows());
        },
        showInSideNav$: of(true),
        showLock$: of(false),
      },
      {
        icon: 'assets/img/custom/dashboard/runs.svg',
        caption: $localize`Runs`,
        route: 'runs',
        showInSideNav$: of(true),
        showLock$: of(false),
      },
      {
        icon: 'assets/img/custom/dashboard/activity.svg',
        caption: $localize`Activity`,
        route: 'activity',
        showInSideNav$: this.flagServices.isFlagEnabled(
          ApFlagId.SHOW_ACTIVITY_LOG
        ),
        showLock$: of(false),
      },
      {
        icon: 'assets/img/custom/dashboard/connections.svg',
        caption: $localize`Connections`,
        route: 'connections',
        showInSideNav$: of(true),
        showLock$: of(false),
      },
      {
        icon: 'assets/img/custom/dashboard/members.svg',
        caption: $localize`Team`,
        route: 'team',
        showInSideNav$: this.embeddingService.getIsInEmbedding$().pipe(
          take(1),
          map((isInEmbedding) => !isInEmbedding)
        ),
        showLock$: this.flagService
          .isFlagEnabled(ApFlagId.PROJECT_MEMBERS_ENABLED)
          .pipe(map((enabled) => !enabled)),
      },

      {
        icon: 'assets/img/custom/dashboard/settings.svg',
        caption: $localize`Settings`,
        route: 'settings',
        showInSideNav$: this.embeddingService.getIsInEmbedding$().pipe(
          take(1),
          map((isInEmbedding) => !isInEmbedding)
        ),
        showLock$: of(false),
      },
    ];
    this.currentVersion$ = this.flagService.getStringFlag(
      ApFlagId.CURRENT_VERSION
    );
    this.latestVersion$ = this.flagService.getStringFlag(
      ApFlagId.LATEST_VERSION
    );
    this.isVersionMatch$ = combineLatest({
      currentVersion: this.currentVersion$,
      latestVersion: this.latestVersion$,
    }).pipe(
      map(({ currentVersion, latestVersion }) => {
        return isVersionMatch(latestVersion, currentVersion);
      })
    );
  }
  ngOnInit(): void {
    this.sideNavRoutes$ = this.dashboardService.getIsInPlatformRoute().pipe(
      map((isInPlatformDashboard) => {
        if (!isInPlatformDashboard) {
          return this.filterRoutesBasedOnRole(
            this.authenticationService.currentUser.projectRole,
            this.mainDashboardRoutes
          );
        }
        return this.platformDashboardRoutes;
      })
    );
  }

  openDocs() {
    window.open('https://activepieces.com/docs', '_blank', 'noopener');
  }
  redirectHome(newWindow: boolean) {
    this.navigationService.navigate('/flows', newWindow);
  }

  public isActive(route: string) {
    return this.router.url.includes(route);
  }

  openSupport() {
    window.open(supportUrl, '_blank', 'noopener');
  }

  private filterRoutesBasedOnRole(
    role: ProjectMemberRole | null | undefined,
    routes: SideNavRoute[]
  ): SideNavRoute[] {
    return routes.map((route) => {
      return {
        ...route,
        showInSideNav$: forkJoin({
          roleCondition: this.isRouteAllowedForRole(role, route.route),
          flagCondition: route.showInSideNav$,
        }).pipe(
          map(
            (conditions) => conditions.roleCondition && conditions.flagCondition
          )
        ),
      };
    });
  }

  private isRouteAllowedForRole(
    role: ProjectMemberRole | null | undefined,
    route?: string
  ) {
    if (role === undefined || role === null || route === undefined) {
      return of(true);
    }

    switch (role) {
      case ProjectMemberRole.ADMIN:
      case ProjectMemberRole.EDITOR:
      case ProjectMemberRole.VIEWER:
        return of(true);
      case ProjectMemberRole.EXTERNAL_CUSTOMER:
        return of(route === 'connections' || route === 'activity');
    }
  }
}
