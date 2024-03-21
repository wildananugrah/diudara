import AppButton from "@/components/AppButton";
import AppInput from "@/components/AppInput";
import Header from "@/components/Header";
import InfoMessage from "@/components/InfoMessage";
import { registerService } from "@/services/user.service";
import Link from "next/link";
import { useState } from "react";

const Login = () => {
  const [Email, setEmail] = useState<string>("");
  const [Password, setPassword] = useState<string>("");
  const [ConfirmPassword, setConfirmPassword] = useState<string>("");
  const [SuccessMessage, setSuccessMessage] = useState<string | undefined>(
    undefined
  );
  const [ErrorMessage, setErrorMessage] = useState<string | undefined>(
    undefined
  );
  async function registerHandler(e: any) {
    const { status, data } = await registerService(
      Email,
      Password,
      ConfirmPassword
    );
    if (status === 200) setSuccessMessage("Successfully registered");
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
          <AppInput
            id="confirmPassword"
            label="Confirm Password"
            value={ConfirmPassword}
            type="password"
            onChange={(e) => {
              setConfirmPassword(e.target.value);
            }}
          />
          <InfoMessage
            successMessage={SuccessMessage}
            errorMessage={ErrorMessage}
          />
          <AppButton id="loginButton" label="Login" onClick={registerHandler} />
          <Link
            data-cyid="registerLink"
            href="/login"
            className="text-blue-600 underline text-sm text-center"
          >{`Already have an account ?`}</Link>
        </div>
      </div>
    </>
  );
};

export default Login;
