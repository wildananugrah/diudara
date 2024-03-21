import Link from "next/link";

const Header = () => {
  const leftMenus = [
    {
      href: "/",
      id: "homeMenu",
      label: "Home",
    },
  ];

  const rightMenus = [
    {
      href: "/login",
      id: "loginMenu",
      label: "Login / Register",
    },
  ];

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
          <li key={index}>
            <Link data-cyid={menu.id} id={menu.id} href={menu.href}>
              {menu.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default Header;
