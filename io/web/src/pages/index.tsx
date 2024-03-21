import { JWT_TOKEN_KEY } from "@/commons/constant.common";
import Header from "@/components/Header";
import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    const token: string | null = localStorage.getItem(JWT_TOKEN_KEY);
  }, []);
  return (
    // header
    <Header />
  );
}
