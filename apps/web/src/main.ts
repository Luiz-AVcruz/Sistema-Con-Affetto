import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { workspaceGenerationInterceptor } from './app/core/workspace-generation';

bootstrapApplication(AppComponent, { providers: [provideHttpClient(withInterceptors([workspaceGenerationInterceptor]))] }).catch(error => console.error(error));
