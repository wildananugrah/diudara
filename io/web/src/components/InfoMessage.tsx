const InfoMessage = ({
  successMessage,
  errorMessage,
}: {
  successMessage: string | undefined;
  errorMessage: string | undefined;
}) => {
  return (
    <div className="flex flex-row w-full">
      <p
        className={`border border-green-200 shadow rounded-md bg-green-100 p-2 text-green-800 font-thin w-full ${
          successMessage !== undefined ? "block" : "hidden"
        }`}
      >
        {successMessage}
      </p>
      <p
        className={`border border-red-200 shadow rounded-md bg-red-100 p-2 text-red-800 font-thin w-full ${
          errorMessage !== undefined ? "block" : "hidden"
        }`}
      >
        {errorMessage}
      </p>
    </div>
  );
};

export default InfoMessage;
