import { IAppContextType } from "@/types/common.type";
import { createContext } from "react";

export const AppContext = createContext<IAppContextType>({
  token: null,
});
