const AppInput = ({
  id,
  label,
  value,
  type,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  type: string;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
}) => {
  return (
    <div>
      <label id={id} className="text-sm">
        {label}:
      </label>
      <input
        data-cyid={id}
        id={id}
        type={type}
        className="rounded-lg border shadow w-full p-2"
        placeholder={label}
        value={value}
        onChange={onChange}
      />
    </div>
  );
};

export default AppInput;
