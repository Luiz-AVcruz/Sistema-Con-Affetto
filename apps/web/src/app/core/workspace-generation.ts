import { signal } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';

export const workspaceGeneration = signal<string | null | undefined>(undefined);
export const workspaceGenerationInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request);
  return next(request.clone({ setHeaders: { 'X-Caixa-Generation': workspaceGeneration() ?? 'none' } }));
};
