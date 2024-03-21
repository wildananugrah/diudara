import Link from "next/link";
import { useContext, useEffect, useState } from "react";
import { AppContext } from "./AppContext";
import { getUserInfo } from "@/services/user.service";
import { IMenu, ISubMenu } from "@/types/common.type";

const Header = () => {
  const { token } = useContext(AppContext);
  const [UserInfo, setUserInfo] = useState<any>(undefined);
  const [Username, setUsername] = useState<string>("username...");
  const [SubMenuShown, setSubMenuShown] = useState<boolean>(false);
  const leftMenus: IMenu[] = [
    {
      href: "/",
      id: "homeMenu",
      label: "Home",
    },
  ];
  const submenus: ISubMenu[] = [
    {
      href: "/product/add",
      id: "addProductMenu",
      label: "Add Product",
    },
    {
      href: "/transaction",
      id: "transactionMenu",
      label: "Transactions",
    },
    {
      href: "/downloaded",
      id: "downloadedProductMenu",
      label: "Downloaded",
    },
    {
      href: "/setting",
      id: "settingMenu",
      label: "Settings",
    },
  ];
  const rightMenus: IMenu[] =
    token === ""
      ? [
          {
            href: "/login",
            id: "loginMenu",
            label: "Login / Register",
          },
        ]
      : [
          {
            href: "/profile/me",
            id: "profileMe",
            label: Username,
            submenus: submenus,
          },
        ];
  async function handleGetUserInfo(token: string) {
    const { status, data } = await getUserInfo(token);
    if (status === 200) setUserInfo(data);
    setUsername(data.user.email.split("@")[0]);
  }
  useEffect(() => {
    if (token !== null && token !== "") handleGetUserInfo(token);
  }, [token]);
  return (
    <div className="flex flex-row w-screen p-2 border shadow justify-between">
      <ul>
        {leftMenus.map((menu, index) => (
          <li key={index}>
            <Link data-cyid={menu.id} id={menu.id} href={menu.href}>
              {menu.label}
            </Link>
          </li>
        ))}
      </ul>
      <ul>
        {rightMenus.map((menu, index) => (
          <li key={index} className="relative">
            <Link
              data-cyid={menu.id}
              id={menu.id}
              href={menu.href}
              onClick={(e) => {
                if (token !== "") {
                  e.preventDefault();
                  e.stopPropagation();
                  setSubMenuShown(!SubMenuShown);
                }
              }}
            >
              {menu.label}
            </Link>
            {menu.submenus && (
              <ul
                className={`shadow border radius w-[150px] -left-10 bg-white p-2 absolute space-y-3 ${
                  SubMenuShown ? "block" : "hidden"
                }`}
              >
                {menu.submenus.map((submenu, index) => (
                  <li key={index} className="w-full">
                    <Link
                      className="text-sm hover:underline"
                      data-cyid={submenu.id}
                      href={submenu.href}
                    >
                      {submenu.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default Header;
