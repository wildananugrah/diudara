import { JWT_TOKEN_KEY } from "@/commons/constant.common";
import { AppContext } from "@/components/AppContext";
import Header from "@/components/Header";
import { useEffect, useState } from "react";

export default function Home() {
  const [token, setToken] = useState<string>("");
  useEffect(() => {
    const _token: string = localStorage.getItem(JWT_TOKEN_KEY) || "";
    setToken(_token);
  }, []);
  return (
    // header
    <AppContext.Provider value={{ token }}>
      <Header />
    </AppContext.Provider>
  );
}
