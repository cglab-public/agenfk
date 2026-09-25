import axios from 'axios';

export const api = axios.create({
  baseURL: '',
  withCredentials: true,
});

export interface MeResponse {
  userId: string;
  orgId: string;
  role: 'admin' | 'viewer';
  email?: string | null;
  name?: string | null;
}
export interface ProvidersResponse { password: boolean; google: boolean; entra: boolean; requiresSetup: boolean }
