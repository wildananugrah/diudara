import { backendEndpoint } from "@/commons/config.common";
import { IAPIResponse } from "@/types/apiResponse.type";
import axios, { AxiosError } from "axios";

export const registerService = async (
  email: string,
  password: string,
  confirmPassword: string
): Promise<IAPIResponse> => {
  try {
    const response = await axios.request({
      url: `${backendEndpoint}/api/users/register`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify({
        email: email,
        password: password,
        confirmPassword: confirmPassword,
      }),
    });
    return {
      status: 200,
      data: response.data,
    };
  } catch (error: any) {
    console.error(error);
    if (error instanceof AxiosError) {
      console.error(error.response?.data);
      return {
        status:
          error.response?.status === undefined ? 400 : error.response?.status,
        data: error.response?.data,
      };
    }
    return {
      status: 500,
      data: error.messages,
    };
  }
};

export const loginService = async (
  email: string,
  password: string
): Promise<IAPIResponse> => {
  try {
    const response = await axios.request({
      url: `${backendEndpoint}/api/users/login`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify({
        email: email,
        password: password,
      }),
    });
    return {
      status: 200,
      data: response.data,
    };
  } catch (error: any) {
    console.error(error);
    if (error instanceof AxiosError) {
      console.error(error.response?.data);
      return {
        status:
          error.response?.status === undefined ? 400 : error.response?.status,
        data: error.response?.data,
      };
    }
    return {
      status: 500,
      data: error.messages,
    };
  }
};

export const getUserInfo = async (token: string): Promise<IAPIResponse> => {
  try {
    const response = await axios.request({
      url: `${backendEndpoint}/api/users/info`,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    return {
      status: 200,
      data: response.data,
    };
  } catch (error: any) {
    console.error(error);
    if (error instanceof AxiosError) {
      console.error(error.response?.data);
      return {
        status:
          error.response?.status === undefined ? 400 : error.response?.status,
        data: error.response?.data,
      };
    }
    return {
      status: 500,
      data: error.messages,
    };
  }
};
