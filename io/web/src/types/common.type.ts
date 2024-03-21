export interface ILoginResponse {
  token: string;
  expired: number;
}

export interface IAppContextType {
  token: string | null;
}

export interface ISubMenu {
  href: string;
  label: string;
  id: string;
}

export interface IMenu {
  href: string;
  label: string;
  id: string;
  submenus?: ISubMenu[];
}
