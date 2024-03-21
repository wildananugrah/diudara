const AppButton = ({
  id,
  onClick,
  label,
  className,
}: {
  id: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  label: string;
  className?: string;
}) => {
  const defaultClassName =
    "border rounded-lg shadow p-2 w-full hover:bg-gray-100 active:bg-gray-200";
  return (
    <button
      data-cyid={id}
      id={id}
      onClick={onClick}
      className={className === undefined ? defaultClassName : className}
    >
      {label}
    </button>
  );
};

export default AppButton;
