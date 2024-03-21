import { JWT_TOKEN_KEY } from "@/commons/constant.common";
import AppButton from "@/components/AppButton";
import AppInput from "@/components/AppInput";
import Header from "@/components/Header";
import InfoMessage from "@/components/InfoMessage";
import { loginService } from "@/services/user.service";
import { ILoginResponse } from "@/types/common.type";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

const Login = () => {
  const router = useRouter();
  const [Email, setEmail] = useState<string>("");
  const [Password, setPassword] = useState<string>("");
  const [SuccessMessage, setSuccessMessage] = useState<string | undefined>(
    undefined
  );
  const [ErrorMessage, setErrorMessage] = useState<string | undefined>(
    undefined
  );
  function successLoginRedirectToLandingPage(data: ILoginResponse) {
    localStorage.setItem(JWT_TOKEN_KEY, data.token);
    router.push("/");
  }
  async function loginHandler(e: any) {
    const { status, data } = await loginService(Email, Password);
    if (status === 200)
      successLoginRedirectToLandingPage({
        token: data.token,
        expired: data.expired,
      });
    if (status !== 200) setErrorMessage(data.message);
  }
  return (
    <>
      <Header />
      <div className="flex flex-col justify-center items-center h-screen">
        <div className="flex flex-col space-y-4 p-2 border shadow rounded-lg w-80">
          <div className="flex flex-row justify-center">
            <p className="font-bold text-lg">DiUdara</p>
          </div>
          <AppInput
            id="email"
            label="Email"
            value={Email}
            type="text"
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <AppInput
            id="password"
            label="Password"
            value={Password}
            type="password"
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          <InfoMessage
            successMessage={SuccessMessage}
            errorMessage={ErrorMessage}
          />
          <AppButton id="loginButton" label="Login" onClick={loginHandler} />
          <Link
            data-cyid="registerLink"
            href="/register"
            className="text-blue-600 underline text-sm text-center"
          >{`Don't have an account`}</Link>
        </div>
      </div>
    </>
  );
};

export default Login;
